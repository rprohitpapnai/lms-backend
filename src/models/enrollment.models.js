import mongoose, { Schema } from "mongoose";

const enrollmentSchema = new Schema(
  {
    // ── Core References ─────────────────────────────────────
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
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
    enrolledBy: {
      // admin/instructor who created the enrollment
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Plan Details ──────────────────────────────────────
    planType: {
      type: String,
      enum: ["one on one", "group", "monthly", "custom"],
      default: "one on one",
      required: true,
    },
    totalClasses: {
      type: Number,
      required: true,
    },
    remainingClasses: {
      type: Number,
      required: true,
    },
    completedClasses: {
      type: Number,
      default: 0,
    },

    // ── Financials ────────────────────────────────────────
    cost: {
      // cost per class
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    paidAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    currency: {
      type: String,
      default: "USD",
    },
    discount: {
      // percentage applied at enrollment time
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // ── Status & Lifecycle ───────────────────────────────
    status: {
      type: String,
      enum: ["active", "completed", "cancelled", "payment pending", "on hold"],
      required: true,
      default: "payment pending",
      index: true,
    },
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    cancelledAt: {
      type: Date,
    },
    cancelReason: {
      type: String,
      default: "",
    },
    completedAt: {
      type: Date,
    },

    // ── Notes ─────────────────────────────────────────────
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// ── Compound indexes ──────────────────────────────────────────
enrollmentSchema.index({ studentId: 1, courseId: 1, organisationId: 1 });
enrollmentSchema.index({ organisationId: 1, status: 1 });
enrollmentSchema.index({ teacherId: 1, organisationId: 1 });

export const Enrollment = mongoose.model("Enrollment", enrollmentSchema);