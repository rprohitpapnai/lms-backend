import mongoose, { Schema } from "mongoose";

const organisationSchema = new Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
    },
    logo: {
      type: String,
      default: "",
    },

    // ── Plan / Subscription ────────────────────────────────
    plan: {
      type: String,
      enum: ["free", "premium", "enterprise", "custom"],
      required: true,
      default: "free",
    },
    planStartDate: {
      type: Date,
    },
    planEndDate: {
      type: Date,
    },
    planStatus: {
      type: Boolean,
      default: false,
    },
    isCancelled: {
      type: Boolean,
      default: false,
    },
    // History of plan changes
    subscriptionHistory: [
      {
        plan: { type: String },
        startDate: { type: Date },
        endDate: { type: Date },
        changedAt: { type: Date, default: Date.now },
        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],

    // ── People ────────────────────────────────────────────
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    // ── Settings ─────────────────────────────────────────
    settings: {
      allowStudentSelfRegister: { type: Boolean, default: true },
      maxStudents: { type: Number, default: null },
      maxTeachers: { type: Number, default: null },
      timezone: { type: String, default: "UTC" },
      language: { type: String, default: "en" },
      currency: { type: String, default: "USD" },
      contactEmail: { type: String, default: "" },
      website: { type: String, default: "" },
      address: { type: String, default: "" },
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Auto-generate slug from name before saving
organisationSchema.pre("save", function (next) {
  if (this.isModified("name") && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }
  next();
});

export const Organisation = mongoose.model("Organisation", organisationSchema);