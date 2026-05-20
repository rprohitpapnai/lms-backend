import mongoose from "mongoose";
import { Enrollment } from "../models/enrollment.models.js";
import { Payment } from "../models/payments.models.js";
import { Course } from "../models/course.models.js";
import { User } from "../models/user.model.js";
import { Session } from "../models/session.models.js";
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

/** Find enrollment scoped to the requesting user's org */
const _findEnrollment = async (enrollmentId, orgId) => {
  const enrollment = await Enrollment.findOne({
    _id: enrollmentId,
    organisationId: orgId,
  });
  if (!enrollment) throw new ApiError(404, "Enrollment not found");
  return enrollment;
};

/** Build a standard populate chain for enrollments */
const _populateEnrollment = (query) =>
  query
    .populate("studentId", "name email username avatar phoneNumber")
    .populate("teacherId", "name email avatar")
    .populate("courseId", "title thumbnail category courseType")
    .populate("enrolledBy", "name email role");

// ═══════════════════════════════════════════════════════════════
//  SECTION 1 ─ CORE ENROLLMENT CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * CREATE ENROLLMENT
 * POST /api/v1/enrollments
 * Protected – admin / superadmin / instructor
 *
 * Body: { studentId, courseId, teacherId, planType, totalClasses,
 *         cost, totalAmount, paidAmount, currency, discount,
 *         startDate, endDate, notes }
 */
const createEnrollment = asyncHandler(async (req, res) => {
  const {
    studentId,
    courseId,
    teacherId,
    planType,
    totalClasses,
    cost,
    totalAmount,
    paidAmount,
    currency,
    discount,
    startDate,
    endDate,
    notes,
  } = req.body;

  // ── Validate required fields ───────────────────────────
  if (!studentId || !courseId || !teacherId || !planType || !totalClasses || totalAmount === undefined) {
    throw new ApiError(
      400,
      "studentId, courseId, teacherId, planType, totalClasses, and totalAmount are required"
    );
  }

  _assertValidId(studentId, "student ID");
  _assertValidId(courseId, "course ID");
  _assertValidId(teacherId, "teacher ID");

  const orgId = req.user.organizationId;

  // ── Verify all parties belong to the same org ──────────
  const [student, teacher, course] = await Promise.all([
    User.findOne({ _id: studentId, organizationId: orgId, role: "student" }),
    User.findOne({ _id: teacherId, organizationId: orgId, role: { $in: ["instructor", "admin", "superadmin"] } }),
    Course.findOne({ _id: courseId, organisationId: orgId }),
  ]);

  if (!student)  throw new ApiError(404, "Student not found in your organization");
  if (!teacher)  throw new ApiError(404, "Teacher not found in your organization");
  if (!course)   throw new ApiError(404, "Course not found in your organization");
  if (course.status !== "published") {
    throw new ApiError(400, "Cannot enroll in a course that is not published");
  }

  // ── Capacity check ──────────────────────────────────────
  if (course.maxStudents !== null) {
    const activeCount = await Enrollment.countDocuments({
      courseId: course._id,
      status: "active",
    });
    if (activeCount >= course.maxStudents) {
      throw new ApiError(400, `Course is full (max ${course.maxStudents} students)`);
    }
  }

  // ── Duplicate enrollment check ──────────────────────────
  const existing = await Enrollment.findOne({
    studentId,
    courseId,
    organisationId: orgId,
    status: { $in: ["active", "payment pending", "on hold"] },
  });
  if (existing) {
    throw new ApiError(
      409,
      "Student is already enrolled in this course with an active/pending enrollment"
    );
  }

  // ── Derive initial status ───────────────────────────────
  const paid = paidAmount || 0;
  const total = totalAmount;
  const initialStatus = paid >= total ? "active" : "payment pending";

  const enrollment = await Enrollment.create({
    studentId,
    courseId,
    teacherId,
    organisationId: orgId,
    enrolledBy: req.user._id,
    planType,
    totalClasses,
    remainingClasses: totalClasses,
    completedClasses: 0,
    cost: cost || 0,
    totalAmount: total,
    paidAmount: paid,
    currency: currency || "USD",
    discount: discount || 0,
    status: initialStatus,
    startDate: startDate ? new Date(startDate) : new Date(),
    endDate: endDate ? new Date(endDate) : null,
    notes: notes || "",
  });

  // ── Increment course enrolledCount ──────────────────────
  await Course.findByIdAndUpdate(courseId, { $inc: { enrolledCount: 1 } });

  // ── Auto-record first payment if paidAmount > 0 ─────────
  if (paid > 0) {
    await Payment.create({
      studentId,
      enrollmentId: enrollment._id,
      organisationId: orgId,
      recordedBy: req.user._id,
      amount: paid,
      currency: currency || "USD",
      status: "completed",
      note: "Initial payment at enrollment",
    });
  }

  const populated = await _populateEnrollment(
    Enrollment.findById(enrollment._id)
  );

  return res
    .status(201)
    .json(new ApiResponse(201, "Enrollment created successfully", populated));
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL ENROLLMENTS  (org-scoped, paginated)
 * GET /api/v1/enrollments?page=&limit=&status=&planType=&studentId=
 *      &teacherId=&courseId=&from=&to=&search=
 * Protected – admin / superadmin / instructor
 */
const getAllEnrollments = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    status,
    planType,
    studentId,
    teacherId,
    courseId,
    from,
    to,
  } = req.query;

  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = req.user.organizationId;

  const filter = { organisationId: orgId };

  // Instructors can only see their own enrollments
  if (req.user.role === "instructor") {
    filter.teacherId = req.user._id;
  } else {
    if (teacherId) { _assertValidId(teacherId, "teacher ID"); filter.teacherId = new mongoose.Types.ObjectId(teacherId); }
  }

  if (status)   filter.status   = status;
  if (planType) filter.planType = planType;
  if (studentId) { _assertValidId(studentId, "student ID"); filter.studentId = new mongoose.Types.ObjectId(studentId); }
  if (courseId)  { _assertValidId(courseId, "course ID");   filter.courseId  = new mongoose.Types.ObjectId(courseId); }

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  const [enrollments, total] = await Promise.all([
    _populateEnrollment(
      Enrollment.find(filter).skip(skip).limit(pagination.limit).sort({ createdAt: -1 })
    ),
    Enrollment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Enrollments fetched successfully", {
      enrollments,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ENROLLMENT BY ID
 * GET /api/v1/enrollments/:enrollmentId
 * Protected – admin / superadmin / instructor (own) / student (own)
 */
const getEnrollmentById = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _populateEnrollment(
    Enrollment.findOne({
      _id: enrollmentId,
      organisationId: req.user.organizationId,
    })
  );

  if (!enrollment) throw new ApiError(404, "Enrollment not found");

  // Students can only view their own enrollment
  if (
    req.user.role === "student" &&
    enrollment.studentId._id.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "Access denied");
  }

  // Instructors can only view enrollments assigned to them
  if (
    req.user.role === "instructor" &&
    enrollment.teacherId._id.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "Access denied");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment fetched successfully", enrollment));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE ENROLLMENT  (plan, classes, dates, notes — NOT status)
 * PATCH /api/v1/enrollments/:enrollmentId
 * Protected – admin / superadmin
 */
const updateEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (["cancelled", "completed"].includes(enrollment.status)) {
    throw new ApiError(400, `Cannot update a ${enrollment.status} enrollment`);
  }

  const allowedFields = [
    "planType", "totalClasses", "remainingClasses",
    "cost", "totalAmount", "currency", "discount",
    "startDate", "endDate", "notes", "teacherId",
  ];

  const updateFields = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updateFields[field] = req.body[field];
  }

  // If teacherId is being changed, verify the new teacher exists in the org
  if (updateFields.teacherId) {
    _assertValidId(updateFields.teacherId, "teacher ID");
    const teacher = await User.findOne({
      _id: updateFields.teacherId,
      organizationId: req.user.organizationId,
      role: { $in: ["instructor", "admin", "superadmin"] },
    });
    if (!teacher) throw new ApiError(404, "Teacher not found in your organization");
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updated = await _populateEnrollment(
    Enrollment.findByIdAndUpdate(
      enrollmentId,
      { $set: updateFields },
      { new: true, runValidators: true }
    )
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment updated successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 2 ─ STATUS TRANSITIONS
// ═══════════════════════════════════════════════════════════════

/**
 * ACTIVATE ENROLLMENT  (payment pending → active)
 * PATCH /api/v1/enrollments/:enrollmentId/activate
 * Protected – admin / superadmin
 */
const activateEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (enrollment.status === "active") {
    throw new ApiError(400, "Enrollment is already active");
  }
  if (["cancelled", "completed"].includes(enrollment.status)) {
    throw new ApiError(400, `Cannot activate a ${enrollment.status} enrollment`);
  }

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    { $set: { status: "active", startDate: enrollment.startDate || new Date() } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment activated successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * CANCEL ENROLLMENT
 * PATCH /api/v1/enrollments/:enrollmentId/cancel
 * Protected – admin / superadmin
 * Body: { cancelReason }
 */
const cancelEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  const { cancelReason } = req.body;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (enrollment.status === "cancelled") {
    throw new ApiError(400, "Enrollment is already cancelled");
  }
  if (enrollment.status === "completed") {
    throw new ApiError(400, "Cannot cancel a completed enrollment");
  }

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: cancelReason || "",
      },
    },
    { new: true }
  );

  // Decrement course enrolledCount
  await Course.findByIdAndUpdate(enrollment.courseId, {
    $inc: { enrolledCount: -1 },
  });

  // Cancel all pending/active sessions tied to this enrollment
  await Session.updateMany(
    {
      studentId: enrollment.studentId,
      courseId: enrollment.courseId,
      organisationId: enrollment.organisationId,
      status: { $in: ["pending", "active"] },
    },
    { $set: { status: "cancelled" } }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment cancelled successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * COMPLETE ENROLLMENT
 * PATCH /api/v1/enrollments/:enrollmentId/complete
 * Protected – admin / superadmin
 */
const completeEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (enrollment.status === "completed") {
    throw new ApiError(400, "Enrollment is already completed");
  }
  if (enrollment.status === "cancelled") {
    throw new ApiError(400, "Cannot complete a cancelled enrollment");
  }

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        remainingClasses: 0,
        completedClasses: enrollment.totalClasses,
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment marked as completed", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * PUT ENROLLMENT ON HOLD
 * PATCH /api/v1/enrollments/:enrollmentId/hold
 * Protected – admin / superadmin
 */
const holdEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (!["active", "payment pending"].includes(enrollment.status)) {
    throw new ApiError(400, `Cannot put a ${enrollment.status} enrollment on hold`);
  }

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    { $set: { status: "on hold" } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Enrollment put on hold", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 3 ─ CLASS TRACKING
// ═══════════════════════════════════════════════════════════════

/**
 * MARK CLASS COMPLETED  (deducts 1 from remainingClasses)
 * PATCH /api/v1/enrollments/:enrollmentId/mark-class
 * Protected – admin / superadmin / instructor (own)
 */
const markClassCompleted = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (enrollment.status !== "active") {
    throw new ApiError(400, "Can only mark classes for active enrollments");
  }

  // Instructor guard
  if (
    req.user.role === "instructor" &&
    enrollment.teacherId.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "You can only mark classes for your own enrollments");
  }

  if (enrollment.remainingClasses <= 0) {
    throw new ApiError(400, "No remaining classes to mark");
  }

  const newRemaining = enrollment.remainingClasses - 1;
  const newCompleted = enrollment.completedClasses + 1;
  const isFullyDone  = newRemaining === 0;

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    {
      $set: {
        remainingClasses: newRemaining,
        completedClasses: newCompleted,
        ...(isFullyDone
          ? { status: "completed", completedAt: new Date() }
          : {}),
      },
    },
    { new: true }
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      isFullyDone
        ? "Last class marked — enrollment auto-completed"
        : "Class marked as completed",
      {
        enrollmentId: updated._id,
        remainingClasses: updated.remainingClasses,
        completedClasses: updated.completedClasses,
        status: updated.status,
      }
    )
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * ADD EXTRA CLASSES  (top-up)
 * PATCH /api/v1/enrollments/:enrollmentId/add-classes
 * Protected – admin / superadmin
 * Body: { extraClasses, extraAmount }
 */
const addExtraClasses = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  const { extraClasses, extraAmount = 0 } = req.body;
  _assertValidId(enrollmentId, "enrollment ID");

  if (!extraClasses || extraClasses <= 0) {
    throw new ApiError(400, "extraClasses must be a positive number");
  }

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (["cancelled", "completed"].includes(enrollment.status)) {
    throw new ApiError(400, `Cannot add classes to a ${enrollment.status} enrollment`);
  }

  const updated = await Enrollment.findByIdAndUpdate(
    enrollmentId,
    {
      $inc: {
        totalClasses:     extraClasses,
        remainingClasses: extraClasses,
        totalAmount:      extraAmount,
      },
    },
    { new: true }
  );

  return res.status(200).json(
    new ApiResponse(200, `${extraClasses} class(es) added successfully`, {
      enrollmentId: updated._id,
      totalClasses:     updated.totalClasses,
      remainingClasses: updated.remainingClasses,
      totalAmount:      updated.totalAmount,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 4 ─ PAYMENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * RECORD PAYMENT
 * POST /api/v1/enrollments/:enrollmentId/payments
 * Protected – admin / superadmin
 * Body: { amount, paymentMethod, transactionId, paymentDate, note, currency }
 */
const recordPayment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  const { amount, paymentMethod, transactionId, paymentDate, note, currency } =
    req.body;

  _assertValidId(enrollmentId, "enrollment ID");

  if (!amount || amount <= 0) {
    throw new ApiError(400, "Payment amount must be a positive number");
  }

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  if (enrollment.status === "cancelled") {
    throw new ApiError(400, "Cannot record payment for a cancelled enrollment");
  }

  const outstanding = enrollment.totalAmount - enrollment.paidAmount;
  if (amount > outstanding) {
    throw new ApiError(
      400,
      `Payment of ${amount} exceeds outstanding balance of ${outstanding}`
    );
  }

  // Create the payment record
  const payment = await Payment.create({
    studentId:    enrollment.studentId,
    enrollmentId: enrollment._id,
    organisationId: enrollment.organisationId,
    recordedBy:   req.user._id,
    amount,
    currency:     currency || enrollment.currency,
    paymentMethod: paymentMethod || "other",
    transactionId: transactionId || "",
    paymentDate:  paymentDate ? new Date(paymentDate) : new Date(),
    note:         note || "",
    status:       "completed",
  });

  // Update enrollment paidAmount and status
  const newPaidAmount = enrollment.paidAmount + amount;
  const newStatus =
    newPaidAmount >= enrollment.totalAmount ? "active" : enrollment.status;

  await Enrollment.findByIdAndUpdate(enrollmentId, {
    $set: {
      paidAmount: newPaidAmount,
      status:     newStatus,
    },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, "Payment recorded successfully", payment));
});

// ─────────────────────────────────────────────────────────────
/**
 * GET PAYMENT HISTORY  for an enrollment
 * GET /api/v1/enrollments/:enrollmentId/payments
 * Protected – admin / superadmin / instructor (own) / student (own)
 */
const getPaymentHistory = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  // Access control
  if (
    req.user.role === "student" &&
    enrollment.studentId.toString() !== req.user._id.toString()
  ) throw new ApiError(403, "Access denied");

  if (
    req.user.role === "instructor" &&
    enrollment.teacherId.toString() !== req.user._id.toString()
  ) throw new ApiError(403, "Access denied");

  const { skip, ...pagination } = getPagination(req.query.page, req.query.limit);

  const [payments, total] = await Promise.all([
    Payment.find({ enrollmentId: enrollment._id })
      .populate("recordedBy", "name email role")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ paymentDate: -1 }),
    Payment.countDocuments({ enrollmentId: enrollment._id }),
  ]);

  const summary = {
    totalAmount:   enrollment.totalAmount,
    paidAmount:    enrollment.paidAmount,
    pendingAmount: enrollment.totalAmount - enrollment.paidAmount,
    currency:      enrollment.currency,
  };

  return res.status(200).json(
    new ApiResponse(200, "Payment history fetched successfully", {
      summary,
      payments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * REFUND PAYMENT
 * PATCH /api/v1/enrollments/:enrollmentId/payments/:paymentId/refund
 * Protected – admin / superadmin
 * Body: { refundReason }
 */
const refundPayment = asyncHandler(async (req, res) => {
  const { enrollmentId, paymentId } = req.params;
  const { refundReason } = req.body;

  _assertValidId(enrollmentId, "enrollment ID");
  _assertValidId(paymentId,    "payment ID");

  const enrollment = await _findEnrollment(enrollmentId, req.user.organizationId);

  const payment = await Payment.findOne({
    _id:          paymentId,
    enrollmentId: enrollment._id,
  });
  if (!payment) throw new ApiError(404, "Payment not found for this enrollment");

  if (payment.status === "refunded") {
    throw new ApiError(400, "Payment has already been refunded");
  }
  if (payment.status !== "completed") {
    throw new ApiError(400, "Only completed payments can be refunded");
  }

  // Update payment record
  await Payment.findByIdAndUpdate(paymentId, {
    $set: {
      status:       "refunded",
      refundedAt:   new Date(),
      refundReason: refundReason || "",
    },
  });

  // Subtract refunded amount from enrollment paidAmount
  const newPaidAmount = Math.max(0, enrollment.paidAmount - payment.amount);
  const newStatus     = newPaidAmount < enrollment.totalAmount ? "payment pending" : enrollment.status;

  await Enrollment.findByIdAndUpdate(enrollmentId, {
    $set: { paidAmount: newPaidAmount, status: newStatus },
  });

  return res.status(200).json(
    new ApiResponse(200, "Payment refunded successfully", {
      paymentId:     payment._id,
      refundedAmount: payment.amount,
      enrollmentNewPaidAmount: newPaidAmount,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 5 ─ STUDENT / TEACHER SPECIFIC VIEWS
// ═══════════════════════════════════════════════════════════════

/**
 * GET MY ENROLLMENTS  (student's own view)
 * GET /api/v1/enrollments/my?status=&page=&limit=
 * Protected – student
 */
const getMyEnrollments = asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    studentId:      req.user._id,
    organisationId: req.user.organizationId,
  };
  if (status) filter.status = status;

  const [enrollments, total] = await Promise.all([
    _populateEnrollment(
      Enrollment.find(filter).skip(skip).limit(pagination.limit).sort({ createdAt: -1 })
    ),
    Enrollment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Your enrollments fetched successfully", {
      enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET MY STUDENTS  (instructor's own view)
 * GET /api/v1/enrollments/my-students?status=&courseId=&page=&limit=
 * Protected – instructor
 */
const getMyStudents = asyncHandler(async (req, res) => {
  const { status, courseId, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    teacherId:      req.user._id,
    organisationId: req.user.organizationId,
  };
  if (status)   filter.status   = status;
  if (courseId) {
    _assertValidId(courseId, "course ID");
    filter.courseId = new mongoose.Types.ObjectId(courseId);
  }

  const [enrollments, total] = await Promise.all([
    _populateEnrollment(
      Enrollment.find(filter).skip(skip).limit(pagination.limit).sort({ createdAt: -1 })
    ),
    Enrollment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Your students fetched successfully", {
      enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 6 ─ ANALYTICS
// ═══════════════════════════════════════════════════════════════

/**
 * GET ENROLLMENT ANALYTICS  (org-level)
 * GET /api/v1/enrollments/analytics?from=&to=
 * Protected – admin / superadmin
 */
const getEnrollmentAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const orgId = new mongoose.Types.ObjectId(req.user.organizationId);

  const matchFilter = { organisationId: orgId };
  if (from || to) {
    matchFilter.createdAt = {};
    if (from) matchFilter.createdAt.$gte = new Date(from);
    if (to)   matchFilter.createdAt.$lte = new Date(to);
  }

  const [
    statusBreakdown,
    planTypeBreakdown,
    revenueStats,
    monthlyTrend,
    recentEnrollments,
  ] = await Promise.all([

    // Breakdown by status
    Enrollment.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Breakdown by plan type
    Enrollment.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$planType", count: { $sum: 1 }, revenue: { $sum: "$paidAmount" } } },
    ]),

    // Revenue summary
    Enrollment.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          totalAmount:   { $sum: "$totalAmount" },
          paidAmount:    { $sum: "$paidAmount" },
          pendingAmount: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
          totalEnrollments: { $sum: 1 },
        },
      },
    ]),

    // Monthly enrollment + revenue trend
    Enrollment.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          enrollments: { $sum: 1 },
          revenue:     { $sum: "$paidAmount" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // 5 most recent enrollments
    _populateEnrollment(
      Enrollment.find(matchFilter).sort({ createdAt: -1 }).limit(5)
    ),
  ]);

  // Format breakdowns into maps
  const byStatus   = {};
  const byPlanType = {};
  statusBreakdown.forEach(({ _id, count }) => { byStatus[_id] = count; });
  planTypeBreakdown.forEach(({ _id, count, revenue }) => {
    byPlanType[_id] = { count, revenue };
  });

  const revenue = revenueStats[0] || {
    totalAmount: 0, paidAmount: 0, pendingAmount: 0, totalEnrollments: 0,
  };

  const completionRate = revenue.totalEnrollments > 0
    ? (((byStatus["completed"] || 0) / revenue.totalEnrollments) * 100).toFixed(1)
    : "0.0";

  return res.status(200).json(
    new ApiResponse(200, "Enrollment analytics fetched successfully", {
      summary: { ...revenue, completionRate: `${completionRate}%` },
      byStatus,
      byPlanType,
      monthlyTrend,
      recentEnrollments,
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET OUTSTANDING PAYMENTS  (enrollments with pending balance)
 * GET /api/v1/enrollments/outstanding?page=&limit=&teacherId=&courseId=
 * Protected – admin / superadmin
 */
const getOutstandingPayments = asyncHandler(async (req, res) => {
  const { page, limit, teacherId, courseId } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = req.user.organizationId;

  const filter = {
    organisationId: orgId,
    status:         "payment pending",
  };
  if (teacherId) { _assertValidId(teacherId, "teacher ID"); filter.teacherId = new mongoose.Types.ObjectId(teacherId); }
  if (courseId)  { _assertValidId(courseId,  "course ID");  filter.courseId  = new mongoose.Types.ObjectId(courseId); }

  const [enrollments, total, totals] = await Promise.all([
    _populateEnrollment(
      Enrollment.find(filter).skip(skip).limit(pagination.limit).sort({ createdAt: -1 })
    ),
    Enrollment.countDocuments(filter),
    Enrollment.aggregate([
      { $match: { ...filter, organisationId: new mongoose.Types.ObjectId(orgId) } },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
        },
      },
    ]),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Outstanding payments fetched successfully", {
      totalOutstanding: totals[0]?.totalOutstanding || 0,
      enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export {
  // Core CRUD
  createEnrollment,
  getAllEnrollments,
  getEnrollmentById,
  updateEnrollment,

  // Status transitions
  activateEnrollment,
  cancelEnrollment,
  completeEnrollment,
  holdEnrollment,

  // Class tracking
  markClassCompleted,
  addExtraClasses,

  // Payment management
  recordPayment,
  getPaymentHistory,
  refundPayment,

  // Role-specific views
  getMyEnrollments,
  getMyStudents,

  // Analytics
  getEnrollmentAnalytics,
  getOutstandingPayments,
};
