import mongoose, { Schema } from "mongoose";

const sessionSchema = new Schema(
  {
    // ── Core References ──────────────────────────────────────
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    enrollmentId: {
      // Link back to the enrollment this session belongs to
      type: mongoose.Schema.Types.ObjectId,
      ref: "Enrollment",
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    scheduledBy: {
      // Admin / instructor who created the session
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Schedule ──────────────────────────────────────────────
    startTime: {
      // Stored as UTC; frontend converts using user's timezone
      type: Date,
      required: true,
      index: true,
    },
    endTime: {
      type: Date,
      required: true,
    },
    durationMinutes: {
      // Computed from startTime/endTime, stored for easy querying
      type: Number,
      default: 0,
    },
    timezone: {
      // IANA timezone string of the session (e.g. "Asia/Kolkata")
      type: String,
      default: "UTC",
    },

    // ── Meeting ───────────────────────────────────────────────
    meetingLink: {
      type: String,
      default: "",
    },
    meetingPlatform: {
      type: String,
      enum: ["zoom", "google_meet", "teams", "custom", "offline"],
      default: "custom",
    },
    meetingId: {
      type: String,
      default: "",
    },
    meetingPassword: {
      type: String,
      default: "",
    },

    // ── Status ────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "active", "completed", "cancelled", "no_show"],
      required: true,
      default: "pending",
      index: true,
    },

    // ── Attendance ────────────────────────────────────────────
    studentAttended: {
      type: Boolean,
      default: null,   // null = not yet marked
    },
    teacherAttended: {
      type: Boolean,
      default: null,
    },
    attendanceMarkedAt: {
      type: Date,
    },
    attendanceMarkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Completion ────────────────────────────────────────────
    completedAt: {
      type: Date,
    },
    sessionNotes: {
      // Notes added by teacher after the session
      type: String,
      default: "",
    },
    homework: {
      type: String,
      default: "",
    },
    recordingUrl: {
      // Cloudinary / external recording link
      type: String,
      default: "",
    },

    // ── Feedback ──────────────────────────────────────────────
    studentFeedback: {
      rating: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, default: "" },
      submittedAt: { type: Date },
    },
    teacherFeedback: {
      comment: { type: String, default: "" },
      submittedAt: { type: Date },
    },

    // ── Rescheduling ──────────────────────────────────────────
    rescheduleFrom: {
      type: Date,
    },
    reschedulingCount: {
      type: Number,
      default: 0,
    },
    rescheduleReason: {
      type: String,
      default: "",
    },
    lastRescheduledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Cancellation ─────────────────────────────────────────
    cancelledAt: {
      type: Date,
    },
    cancelReason: {
      type: String,
      default: "",
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // Whether the cancelled session counts against the student's quota
    deductFromQuota: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────
sessionSchema.index({ organisationId: 1, startTime: 1 });
sessionSchema.index({ teacherId: 1, startTime: 1 });
sessionSchema.index({ studentId: 1, startTime: 1 });
sessionSchema.index({ enrollmentId: 1, status: 1 });

export const Session = mongoose.model("Session", sessionSchema);