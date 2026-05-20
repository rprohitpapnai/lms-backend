import mongoose from "mongoose";
import { Session } from "../models/session.models.js";
import { Enrollment } from "../models/enrollment.models.js";
import { User } from "../models/user.model.js";
import { Course } from "../models/course.models.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getPagination } from "../utils/pagination.utils.js";
import { isValidObjectId } from "../utils/validation.utils.js";

// ═══════════════════════════════════════════════════════════════
//  PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════

const _assertValidId = (id, label = "ID") => {
  if (!isValidObjectId(id)) throw new ApiError(400, `Invalid ${label}`);
};

/** Find a session scoped to requesting user's org */
const _findSession = async (sessionId, orgId) => {
  const session = await Session.findOne({
    _id: sessionId,
    organisationId: orgId,
  });
  if (!session) throw new ApiError(404, "Session not found");
  return session;
};

/** Standard populate chain for sessions */
const _populateSession = (query) =>
  query
    .populate("studentId",    "name email username avatar phoneNumber")
    .populate("teacherId",    "name email avatar")
    .populate("courseId",     "title thumbnail category")
    .populate("enrollmentId", "planType totalClasses remainingClasses status")
    .populate("scheduledBy",  "name email role")
    .populate("cancelledBy",  "name email role")
    .populate("lastRescheduledBy", "name email role");

/** Compute duration in minutes between two Date objects */
const _calcDuration = (start, end) =>
  Math.round((new Date(end) - new Date(start)) / 60000);

/**
 * Guard: only the session's teacher, an admin, or superadmin
 * may mutate a session.
 */
const _assertSessionWriteAccess = (user, session) => {
  if (["admin", "superadmin"].includes(user.role)) return;
  if (session.teacherId.toString() === user._id.toString()) return;
  throw new ApiError(403, "You do not have permission to modify this session");
};

// ═══════════════════════════════════════════════════════════════
//  SECTION 1 ─ CORE SESSION CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * SCHEDULE SESSION
 * POST /api/v1/sessions
 * Protected – admin / superadmin / instructor
 *
 * Body: { enrollmentId, startTime, endTime, meetingLink,
 *         meetingPlatform, meetingId, meetingPassword, timezone }
 */
const scheduleSession = asyncHandler(async (req, res) => {
  const {
    enrollmentId,
    startTime,
    endTime,
    meetingLink,
    meetingPlatform,
    meetingId,
    meetingPassword,
    timezone,
  } = req.body;

  // ── Validate required fields ───────────────────────────
  if (!enrollmentId || !startTime || !endTime) {
    throw new ApiError(400, "enrollmentId, startTime, and endTime are required");
  }

  _assertValidId(enrollmentId, "enrollment ID");

  const orgId = req.user.organizationId;

  // ── Verify enrollment exists and is active ─────────────
  const enrollment = await Enrollment.findOne({
    _id: enrollmentId,
    organisationId: orgId,
    status: "active",
  });
  if (!enrollment) {
    throw new ApiError(
      404,
      "Active enrollment not found. Cannot schedule a session for inactive or non-existent enrollment."
    );
  }

  // ── Instructor guard ───────────────────────────────────
  if (
    req.user.role === "instructor" &&
    enrollment.teacherId.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "You can only schedule sessions for your own enrollments");
  }

  // ── No remaining classes ───────────────────────────────
  if (enrollment.remainingClasses <= 0) {
    throw new ApiError(400, "No remaining classes in this enrollment to schedule");
  }

  // ── Time validation ────────────────────────────────────
  const start = new Date(startTime);
  const end   = new Date(endTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new ApiError(400, "Invalid startTime or endTime format");
  }
  if (end <= start) {
    throw new ApiError(400, "endTime must be after startTime");
  }
  if (start < new Date()) {
    throw new ApiError(400, "Cannot schedule a session in the past");
  }

  const durationMinutes = _calcDuration(start, end);

  // ── Teacher scheduling conflict check ──────────────────
  const teacherConflict = await Session.findOne({
    teacherId:      enrollment.teacherId,
    organisationId: orgId,
    status:         { $in: ["pending", "active"] },
    $or: [
      { startTime: { $lt: end,   $gte: start } },
      { endTime:   { $gt: start, $lte: end   } },
      { startTime: { $lte: start }, endTime: { $gte: end } },
    ],
  });
  if (teacherConflict) {
    throw new ApiError(
      409,
      "Teacher already has a session scheduled during this time slot"
    );
  }

  // ── Student scheduling conflict check ──────────────────
  const studentConflict = await Session.findOne({
    studentId:      enrollment.studentId,
    organisationId: orgId,
    status:         { $in: ["pending", "active"] },
    $or: [
      { startTime: { $lt: end,   $gte: start } },
      { endTime:   { $gt: start, $lte: end   } },
      { startTime: { $lte: start }, endTime: { $gte: end } },
    ],
  });
  if (studentConflict) {
    throw new ApiError(
      409,
      "Student already has a session scheduled during this time slot"
    );
  }

  // ── Create session ─────────────────────────────────────
  const session = await Session.create({
    courseId:        enrollment.courseId,
    enrollmentId:    enrollment._id,
    studentId:       enrollment.studentId,
    teacherId:       enrollment.teacherId,
    organisationId:  orgId,
    scheduledBy:     req.user._id,
    startTime:       start,
    endTime:         end,
    durationMinutes,
    timezone:        timezone || "UTC",
    meetingLink:     meetingLink || "",
    meetingPlatform: meetingPlatform || "custom",
    meetingId:       meetingId || "",
    meetingPassword: meetingPassword || "",
    status: "pending",
  });

  const populated = await _populateSession(Session.findById(session._id));

  return res
    .status(201)
    .json(new ApiResponse(201, "Session scheduled successfully", populated));
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL SESSIONS  (org-scoped, paginated)
 * GET /api/v1/sessions?page=&limit=&status=&teacherId=&studentId=
 *      &courseId=&enrollmentId=&from=&to=&upcoming=true
 * Protected – admin / superadmin / instructor
 */
const getAllSessions = asyncHandler(async (req, res) => {
  const {
    page, limit, status, teacherId, studentId,
    courseId, enrollmentId, from, to, upcoming,
  } = req.query;

  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = req.user.organizationId;

  const filter = { organisationId: orgId };

  // Instructors only see their own sessions
  if (req.user.role === "instructor") {
    filter.teacherId = req.user._id;
  } else {
    if (teacherId) {
      _assertValidId(teacherId, "teacher ID");
      filter.teacherId = new mongoose.Types.ObjectId(teacherId);
    }
  }

  if (status)       filter.status   = status;
  if (studentId)    { _assertValidId(studentId, "student ID");       filter.studentId    = new mongoose.Types.ObjectId(studentId); }
  if (courseId)     { _assertValidId(courseId, "course ID");         filter.courseId     = new mongoose.Types.ObjectId(courseId); }
  if (enrollmentId) { _assertValidId(enrollmentId, "enrollment ID"); filter.enrollmentId = new mongoose.Types.ObjectId(enrollmentId); }

  if (upcoming === "true") {
    filter.startTime = { $gte: new Date() };
    filter.status    = { $in: ["pending", "active"] };
  } else if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to)   filter.startTime.$lte = new Date(to);
  }

  const [sessions, total] = await Promise.all([
    _populateSession(
      Session.find(filter).skip(skip).limit(pagination.limit).sort({ startTime: 1 })
    ),
    Session.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Sessions fetched successfully", {
      sessions,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET SESSION BY ID
 * GET /api/v1/sessions/:sessionId
 * Protected – admin / superadmin / instructor (own) / student (own)
 */
const getSessionById = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  _assertValidId(sessionId, "session ID");

  const session = await _populateSession(
    Session.findOne({ _id: sessionId, organisationId: req.user.organizationId })
  );

  if (!session) throw new ApiError(404, "Session not found");

  // Students can only view their own sessions
  if (
    req.user.role === "student" &&
    session.studentId._id.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "Access denied");
  }

  // Instructors can only view sessions assigned to them
  if (
    req.user.role === "instructor" &&
    session.teacherId._id.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "Access denied");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Session fetched successfully", session));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE SESSION  (meeting details, time — before it starts)
 * PATCH /api/v1/sessions/:sessionId
 * Protected – admin / superadmin / instructor (own)
 */
const updateSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  _assertValidId(sessionId, "session ID");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["pending"].includes(session.status)) {
    throw new ApiError(400, `Cannot update a session that is ${session.status}`);
  }

  const { startTime, endTime, meetingLink, meetingPlatform, meetingId, meetingPassword, timezone } = req.body;

  const updateFields = {};
  if (meetingLink)     updateFields.meetingLink     = meetingLink;
  if (meetingPlatform) updateFields.meetingPlatform = meetingPlatform;
  if (meetingId)       updateFields.meetingId       = meetingId;
  if (meetingPassword) updateFields.meetingPassword = meetingPassword;
  if (timezone)        updateFields.timezone        = timezone;

  // If times are changing, re-validate and re-check conflicts
  if (startTime || endTime) {
    const newStart = startTime ? new Date(startTime) : session.startTime;
    const newEnd   = endTime   ? new Date(endTime)   : session.endTime;

    if (newEnd <= newStart) throw new ApiError(400, "endTime must be after startTime");
    if (newStart < new Date()) throw new ApiError(400, "Cannot move session to the past");

    // Conflict checks (excluding this session itself)
    const conflictFilter = {
      _id:            { $ne: session._id },
      organisationId: req.user.organizationId,
      status:         { $in: ["pending", "active"] },
      $or: [
        { startTime: { $lt: newEnd,   $gte: newStart } },
        { endTime:   { $gt: newStart, $lte: newEnd   } },
        { startTime: { $lte: newStart }, endTime: { $gte: newEnd } },
      ],
    };

    const [teacherConflict, studentConflict] = await Promise.all([
      Session.findOne({ ...conflictFilter, teacherId: session.teacherId }),
      Session.findOne({ ...conflictFilter, studentId: session.studentId }),
    ]);

    if (teacherConflict) throw new ApiError(409, "Teacher has a conflicting session at the new time");
    if (studentConflict) throw new ApiError(409, "Student has a conflicting session at the new time");

    updateFields.startTime       = newStart;
    updateFields.endTime         = newEnd;
    updateFields.durationMinutes = _calcDuration(newStart, newEnd);
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updated = await _populateSession(
    Session.findByIdAndUpdate(sessionId, { $set: updateFields }, { new: true })
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Session updated successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 2 ─ STATUS TRANSITIONS
// ═══════════════════════════════════════════════════════════════

/**
 * START SESSION  (pending → active)
 * PATCH /api/v1/sessions/:sessionId/start
 * Protected – admin / superadmin / instructor (own)
 */
const startSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  _assertValidId(sessionId, "session ID");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (session.status !== "pending") {
    throw new ApiError(400, `Cannot start a session that is ${session.status}`);
  }

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    { $set: { status: "active" } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Session started successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * COMPLETE SESSION  (active → completed)
 * PATCH /api/v1/sessions/:sessionId/complete
 * Protected – admin / superadmin / instructor (own)
 * Body: { sessionNotes, homework, recordingUrl }
 */
const completeSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { sessionNotes, homework, recordingUrl } = req.body;
  _assertValidId(sessionId, "session ID");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["active", "pending"].includes(session.status)) {
    throw new ApiError(400, `Cannot complete a session that is ${session.status}`);
  }

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        status:       "completed",
        completedAt:  new Date(),
        sessionNotes: sessionNotes || session.sessionNotes,
        homework:     homework     || session.homework,
        recordingUrl: recordingUrl || session.recordingUrl,
      },
    },
    { new: true }
  );

  // ── Deduct from enrollment's remaining classes ──────────
  if (session.enrollmentId) {
    const enrollment = await Enrollment.findById(session.enrollmentId);
    if (enrollment && enrollment.status === "active") {
      const newRemaining  = Math.max(0, enrollment.remainingClasses - 1);
      const newCompleted  = enrollment.completedClasses + 1;
      const isFullyDone   = newRemaining === 0;

      await Enrollment.findByIdAndUpdate(session.enrollmentId, {
        $set: {
          remainingClasses: newRemaining,
          completedClasses: newCompleted,
          ...(isFullyDone
            ? { status: "completed", completedAt: new Date() }
            : {}),
        },
      });
    }
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Session completed successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * CANCEL SESSION
 * PATCH /api/v1/sessions/:sessionId/cancel
 * Protected – admin / superadmin / instructor (own)
 * Body: { cancelReason, deductFromQuota }
 */
const cancelSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { cancelReason, deductFromQuota = false } = req.body;
  _assertValidId(sessionId, "session ID");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (session.status === "cancelled") {
    throw new ApiError(400, "Session is already cancelled");
  }
  if (session.status === "completed") {
    throw new ApiError(400, "Cannot cancel a completed session");
  }

  await Session.findByIdAndUpdate(sessionId, {
    $set: {
      status:          "cancelled",
      cancelledAt:     new Date(),
      cancelReason:    cancelReason || "",
      cancelledBy:     req.user._id,
      deductFromQuota: deductFromQuota,
    },
  });

  // If deductFromQuota is true, still decrement remaining classes
  if (deductFromQuota && session.enrollmentId) {
    await Enrollment.findByIdAndUpdate(session.enrollmentId, {
      $inc: { remainingClasses: -1, completedClasses: 1 },
    });
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Session cancelled successfully", { sessionId, deductFromQuota }));
});

// ─────────────────────────────────────────────────────────────
/**
 * MARK NO-SHOW
 * PATCH /api/v1/sessions/:sessionId/no-show
 * Protected – admin / superadmin / instructor (own)
 * Body: { deductFromQuota }
 */
const markNoShow = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { deductFromQuota = true } = req.body;
  _assertValidId(sessionId, "session ID");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["pending", "active"].includes(session.status)) {
    throw new ApiError(400, `Cannot mark no-show for a ${session.status} session`);
  }

  await Session.findByIdAndUpdate(sessionId, {
    $set: {
      status:           "no_show",
      studentAttended:  false,
      completedAt:      new Date(),
      deductFromQuota:  deductFromQuota,
    },
  });

  // Deduct from quota if configured (no-shows typically count against student)
  if (deductFromQuota && session.enrollmentId) {
    await Enrollment.findByIdAndUpdate(session.enrollmentId, {
      $inc: { remainingClasses: -1, completedClasses: 1 },
    });
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Session marked as no-show", { sessionId, deductFromQuota }));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 3 ─ RESCHEDULING
// ═══════════════════════════════════════════════════════════════

/**
 * RESCHEDULE SESSION
 * PATCH /api/v1/sessions/:sessionId/reschedule
 * Protected – admin / superadmin / instructor (own)
 * Body: { startTime, endTime, rescheduleReason, meetingLink }
 */
const rescheduleSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { startTime, endTime, rescheduleReason, meetingLink } = req.body;
  _assertValidId(sessionId, "session ID");

  if (!startTime || !endTime) {
    throw new ApiError(400, "New startTime and endTime are required for rescheduling");
  }

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["pending", "active"].includes(session.status)) {
    throw new ApiError(400, `Cannot reschedule a ${session.status} session`);
  }

  const newStart = new Date(startTime);
  const newEnd   = new Date(endTime);

  if (isNaN(newStart.getTime()) || isNaN(newEnd.getTime())) {
    throw new ApiError(400, "Invalid startTime or endTime format");
  }
  if (newEnd <= newStart) throw new ApiError(400, "endTime must be after startTime");
  if (newStart < new Date()) throw new ApiError(400, "Cannot reschedule to the past");

  // Conflict checks (excluding this session)
  const conflictFilter = {
    _id:            { $ne: session._id },
    organisationId: req.user.organizationId,
    status:         { $in: ["pending", "active"] },
    $or: [
      { startTime: { $lt: newEnd,   $gte: newStart } },
      { endTime:   { $gt: newStart, $lte: newEnd   } },
      { startTime: { $lte: newStart }, endTime: { $gte: newEnd } },
    ],
  };

  const [teacherConflict, studentConflict] = await Promise.all([
    Session.findOne({ ...conflictFilter, teacherId: session.teacherId }),
    Session.findOne({ ...conflictFilter, studentId: session.studentId }),
  ]);

  if (teacherConflict) throw new ApiError(409, "Teacher has a conflicting session at this time");
  if (studentConflict) throw new ApiError(409, "Student has a conflicting session at this time");

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        rescheduleFrom:     session.startTime,  // original time
        startTime:          newStart,
        endTime:            newEnd,
        durationMinutes:    _calcDuration(newStart, newEnd),
        rescheduleReason:   rescheduleReason || "",
        lastRescheduledBy:  req.user._id,
        status:             "pending",           // reset to pending after reschedule
        ...(meetingLink ? { meetingLink } : {}),
      },
      $inc: { reschedulingCount: 1 },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Session rescheduled successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 4 ─ ATTENDANCE
// ═══════════════════════════════════════════════════════════════

/**
 * MARK ATTENDANCE
 * PATCH /api/v1/sessions/:sessionId/attendance
 * Protected – admin / superadmin / instructor (own)
 * Body: { studentAttended, teacherAttended }
 */
const markAttendance = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { studentAttended, teacherAttended } = req.body;
  _assertValidId(sessionId, "session ID");

  if (studentAttended === undefined && teacherAttended === undefined) {
    throw new ApiError(400, "Provide studentAttended and/or teacherAttended");
  }

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["active", "completed"].includes(session.status)) {
    throw new ApiError(400, "Attendance can only be marked for active or completed sessions");
  }

  const updateFields = {
    attendanceMarkedAt: new Date(),
    attendanceMarkedBy: req.user._id,
  };
  if (studentAttended !== undefined) updateFields.studentAttended = studentAttended;
  if (teacherAttended !== undefined) updateFields.teacherAttended = teacherAttended;

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    { $set: updateFields },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Attendance marked successfully", {
      sessionId:       updated._id,
      studentAttended: updated.studentAttended,
      teacherAttended: updated.teacherAttended,
      markedAt:        updated.attendanceMarkedAt,
    }));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 5 ─ NOTES, HOMEWORK & RECORDING
// ═══════════════════════════════════════════════════════════════

/**
 * ADD SESSION NOTES  (post-session teacher notes & homework)
 * PATCH /api/v1/sessions/:sessionId/notes
 * Protected – admin / superadmin / instructor (own)
 * Body: { sessionNotes, homework, recordingUrl }
 */
const addSessionNotes = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { sessionNotes, homework, recordingUrl } = req.body;
  _assertValidId(sessionId, "session ID");

  if (!sessionNotes && !homework && !recordingUrl) {
    throw new ApiError(400, "Provide sessionNotes, homework, or recordingUrl");
  }

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (!["active", "completed"].includes(session.status)) {
    throw new ApiError(400, "Notes can only be added for active or completed sessions");
  }

  const updateFields = {};
  if (sessionNotes !== undefined) updateFields.sessionNotes = sessionNotes;
  if (homework     !== undefined) updateFields.homework     = homework;
  if (recordingUrl !== undefined) updateFields.recordingUrl = recordingUrl;

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    { $set: updateFields },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Session notes updated successfully", {
      sessionId:    updated._id,
      sessionNotes: updated.sessionNotes,
      homework:     updated.homework,
      recordingUrl: updated.recordingUrl,
    }));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 6 ─ FEEDBACK
// ═══════════════════════════════════════════════════════════════

/**
 * SUBMIT STUDENT FEEDBACK
 * PATCH /api/v1/sessions/:sessionId/feedback/student
 * Protected – student (own session only)
 * Body: { rating, comment }
 */
const submitStudentFeedback = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { rating, comment } = req.body;
  _assertValidId(sessionId, "session ID");

  if (!rating || rating < 1 || rating > 5) {
    throw new ApiError(400, "Rating must be between 1 and 5");
  }

  const session = await _findSession(sessionId, req.user.organizationId);

  if (session.studentId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "You can only submit feedback for your own sessions");
  }

  if (session.status !== "completed") {
    throw new ApiError(400, "Feedback can only be submitted for completed sessions");
  }

  if (session.studentFeedback?.rating !== null) {
    throw new ApiError(400, "Feedback has already been submitted for this session");
  }

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        "studentFeedback.rating":      rating,
        "studentFeedback.comment":     comment || "",
        "studentFeedback.submittedAt": new Date(),
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Student feedback submitted successfully", updated.studentFeedback));
});

// ─────────────────────────────────────────────────────────────
/**
 * SUBMIT TEACHER FEEDBACK / REMARKS
 * PATCH /api/v1/sessions/:sessionId/feedback/teacher
 * Protected – instructor (own session) / admin / superadmin
 * Body: { comment }
 */
const submitTeacherFeedback = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { comment } = req.body;
  _assertValidId(sessionId, "session ID");

  if (!comment) throw new ApiError(400, "comment is required");

  const session = await _findSession(sessionId, req.user.organizationId);
  _assertSessionWriteAccess(req.user, session);

  if (session.status !== "completed") {
    throw new ApiError(400, "Feedback can only be submitted for completed sessions");
  }

  const updated = await Session.findByIdAndUpdate(
    sessionId,
    {
      $set: {
        "teacherFeedback.comment":     comment,
        "teacherFeedback.submittedAt": new Date(),
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Teacher feedback submitted successfully", updated.teacherFeedback));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 7 ─ ROLE-SPECIFIC VIEWS
// ═══════════════════════════════════════════════════════════════

/**
 * GET MY SESSIONS  (student's own view)
 * GET /api/v1/sessions/my?status=&from=&to=&upcoming=&page=&limit=
 * Protected – student
 */
const getMySessions = asyncHandler(async (req, res) => {
  const { status, from, to, upcoming, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    studentId:      req.user._id,
    organisationId: req.user.organizationId,
  };

  if (upcoming === "true") {
    filter.startTime = { $gte: new Date() };
    filter.status    = { $in: ["pending", "active"] };
  } else {
    if (status) filter.status = status;
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = new Date(from);
      if (to)   filter.startTime.$lte = new Date(to);
    }
  }

  const [sessions, total] = await Promise.all([
    _populateSession(
      Session.find(filter).skip(skip).limit(pagination.limit).sort({ startTime: 1 })
    ),
    Session.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Your sessions fetched successfully", {
      sessions,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET MY SCHEDULED SESSIONS  (instructor's own view)
 * GET /api/v1/sessions/my-schedule?status=&studentId=&from=&to=&upcoming=&page=&limit=
 * Protected – instructor
 */
const getMySchedule = asyncHandler(async (req, res) => {
  const { status, studentId, from, to, upcoming, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    teacherId:      req.user._id,
    organisationId: req.user.organizationId,
  };

  if (upcoming === "true") {
    filter.startTime = { $gte: new Date() };
    filter.status    = { $in: ["pending", "active"] };
  } else {
    if (status) filter.status = status;
    if (from || to) {
      filter.startTime = {};
      if (from) filter.startTime.$gte = new Date(from);
      if (to)   filter.startTime.$lte = new Date(to);
    }
  }

  if (studentId) {
    _assertValidId(studentId, "student ID");
    filter.studentId = new mongoose.Types.ObjectId(studentId);
  }

  const [sessions, total] = await Promise.all([
    _populateSession(
      Session.find(filter).skip(skip).limit(pagination.limit).sort({ startTime: 1 })
    ),
    Session.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Your schedule fetched successfully", {
      sessions,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 8 ─ ANALYTICS
// ═══════════════════════════════════════════════════════════════

/**
 * GET SESSION ANALYTICS  (org-level)
 * GET /api/v1/sessions/analytics?from=&to=
 * Protected – admin / superadmin
 */
const getSessionAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const orgId = new mongoose.Types.ObjectId(req.user.organizationId);

  const matchFilter = { organisationId: orgId };
  if (from || to) {
    matchFilter.startTime = {};
    if (from) matchFilter.startTime.$gte = new Date(from);
    if (to)   matchFilter.startTime.$lte = new Date(to);
  }

  const [
    statusBreakdown,
    attendanceStats,
    ratingStats,
    monthlyTrend,
    topTeachers,
    upcomingCount,
  ] = await Promise.all([

    // Breakdown by status
    Session.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Attendance stats
    Session.aggregate([
      { $match: { ...matchFilter, status: "completed" } },
      {
        $group: {
          _id: null,
          totalCompleted:      { $sum: 1 },
          studentsAttended:    { $sum: { $cond: ["$studentAttended", 1, 0] } },
          studentsAbsent:      { $sum: { $cond: [{ $eq: ["$studentAttended", false] }, 1, 0] } },
          teachersAttended:    { $sum: { $cond: ["$teacherAttended", 1, 0] } },
          totalDurationMins:   { $sum: "$durationMinutes" },
          avgDurationMins:     { $avg: "$durationMinutes" },
          rescheduledSessions: { $sum: { $cond: [{ $gt: ["$reschedulingCount", 0] }, 1, 0] } },
        },
      },
    ]),

    // Rating stats (from completed sessions with student feedback)
    Session.aggregate([
      {
        $match: {
          ...matchFilter,
          status: "completed",
          "studentFeedback.rating": { $ne: null },
        },
      },
      {
        $group: {
          _id: null,
          avgRating:    { $avg: "$studentFeedback.rating" },
          totalRatings: { $sum: 1 },
          rating5:      { $sum: { $cond: [{ $eq: ["$studentFeedback.rating", 5] }, 1, 0] } },
          rating4:      { $sum: { $cond: [{ $eq: ["$studentFeedback.rating", 4] }, 1, 0] } },
          rating3:      { $sum: { $cond: [{ $eq: ["$studentFeedback.rating", 3] }, 1, 0] } },
          rating2:      { $sum: { $cond: [{ $eq: ["$studentFeedback.rating", 2] }, 1, 0] } },
          rating1:      { $sum: { $cond: [{ $eq: ["$studentFeedback.rating", 1] }, 1, 0] } },
        },
      },
    ]),

    // Monthly session trend
    Session.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { year: { $year: "$startTime" }, month: { $month: "$startTime" } },
          total:     { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          no_show:   { $sum: { $cond: [{ $eq: ["$status", "no_show"]   }, 1, 0] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // Top 5 teachers by sessions completed
    Session.aggregate([
      { $match: { ...matchFilter, status: "completed" } },
      {
        $group: {
          _id:            "$teacherId",
          sessionsCompleted: { $sum: 1 },
          avgRating:      { $avg: "$studentFeedback.rating" },
          totalDuration:  { $sum: "$durationMinutes" },
        },
      },
      { $sort: { sessionsCompleted: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "teacher",
        },
      },
      { $unwind: "$teacher" },
      {
        $project: {
          "teacher.password":     0,
          "teacher.refreshToken": 0,
        },
      },
    ]),

    // Upcoming sessions count
    Session.countDocuments({
      organisationId: orgId,
      status:         { $in: ["pending", "active"] },
      startTime:      { $gte: new Date() },
    }),
  ]);

  // Format status breakdown
  const byStatus = {};
  statusBreakdown.forEach(({ _id, count }) => { byStatus[_id] = count; });

  const attendance  = attendanceStats[0]  || {};
  const ratings     = ratingStats[0]      || {};

  return res.status(200).json(
    new ApiResponse(200, "Session analytics fetched successfully", {
      summary: {
        byStatus,
        total:          Object.values(byStatus).reduce((s, c) => s + c, 0),
        upcomingCount,
      },
      attendance,
      ratings: {
        average:      ratings.avgRating ? Number(ratings.avgRating.toFixed(2)) : null,
        total:        ratings.totalRatings || 0,
        distribution: {
          5: ratings.rating5 || 0,
          4: ratings.rating4 || 0,
          3: ratings.rating3 || 0,
          2: ratings.rating2 || 0,
          1: ratings.rating1 || 0,
        },
      },
      monthlyTrend,
      topTeachers,
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET TEACHER AVAILABILITY  (slots blocked by existing sessions)
 * GET /api/v1/sessions/availability/:teacherId?date=YYYY-MM-DD
 * Protected – admin / superadmin / instructor (self)
 */
const getTeacherAvailability = asyncHandler(async (req, res) => {
  const { teacherId } = req.params;
  const { date } = req.query;
  _assertValidId(teacherId, "teacher ID");

  if (!date) throw new ApiError(400, "date query param is required (YYYY-MM-DD)");

  // Authorization: instructor can only check their own availability
  if (
    req.user.role === "instructor" &&
    req.user._id.toString() !== teacherId
  ) {
    throw new ApiError(403, "You can only check your own availability");
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd   = new Date(`${date}T23:59:59.999Z`);

  if (isNaN(dayStart.getTime())) throw new ApiError(400, "Invalid date format. Use YYYY-MM-DD");

  const bookedSlots = await Session.find({
    teacherId:      new mongoose.Types.ObjectId(teacherId),
    organisationId: req.user.organizationId,
    status:         { $in: ["pending", "active"] },
    startTime:      { $gte: dayStart, $lte: dayEnd },
  })
    .select("startTime endTime durationMinutes status")
    .sort({ startTime: 1 });

  return res.status(200).json(
    new ApiResponse(200, "Teacher availability fetched successfully", {
      teacherId,
      date,
      bookedSlots,
      totalBookedSlots: bookedSlots.length,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export {
  // Core CRUD
  scheduleSession,
  getAllSessions,
  getSessionById,
  updateSession,

  // Status transitions
  startSession,
  completeSession,
  cancelSession,
  markNoShow,

  // Rescheduling
  rescheduleSession,

  // Attendance
  markAttendance,

  // Notes, homework & recording
  addSessionNotes,

  // Feedback
  submitStudentFeedback,
  submitTeacherFeedback,

  // Role-specific views
  getMySessions,
  getMySchedule,

  // Analytics
  getSessionAnalytics,
  getTeacherAvailability,
};
