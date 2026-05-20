import mongoose, { Schema } from "mongoose";

const paymentSchema = new Schema(
  {
    // ── Core references ───────────────────────────────────
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Enrollment",
      required: true,
      index: true,
    },
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    recordedBy: {
      // admin/instructor who recorded the payment
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // ── Financials ────────────────────────────────────────
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
    },

    // ── Payment details ───────────────────────────────────
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "upi", "card", "cheque", "other"],
      default: "other",
    },
    transactionId: {
      type: String,
      default: "",
    },
    paymentDate: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      default: "",
    },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      required: true,
      default: "completed",
    },
    refundedAt: {
      type: Date,
    },
    refundReason: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

paymentSchema.index({ studentId: 1, organisationId: 1 });
paymentSchema.index({ enrollmentId: 1 });

export const Payment = mongoose.model("Payment", paymentSchema);
