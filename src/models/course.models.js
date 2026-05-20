import mongoose, { Schema } from "mongoose";

// ── Curriculum / Chapter / Lesson hierarchy ───────────────────
const lessonSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    videoUrl: { type: String, default: "" },       // Cloudinary URL
    duration: { type: Number, default: 0 },         // seconds
    isFreePreview: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    attachments: [
      {
        name: { type: String },
        url: { type: String },
      },
    ],
  },
  { _id: true }
);

const chapterSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
    lessons: [lessonSchema],
  },
  { _id: true }
);

// ── Main Course Schema ────────────────────────────────────────
const courseSchema = new Schema(
  {
    // Ownership & multi-tenancy
    organisationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required: true,
      index: true,
    },
    instructorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Core info
    title: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    description: { type: String, required: true },
    shortDescription: { type: String, default: "", maxlength: 300 },
    thumbnail: { type: String, default: "" },       // Cloudinary URL
    previewVideoUrl: { type: String, default: "" }, // Cloudinary URL

    // Categorization
    category: { type: String, required: true, trim: true },
    tags: [{ type: String, trim: true, lowercase: true }],
    level: {
      type: String,
      enum: ["beginner", "intermediate", "advanced", "all levels"],
      default: "all levels",
    },
    language: { type: String, default: "English" },

    // Delivery type
    courseType: {
      type: String,
      enum: ["live", "recorded", "hybrid"],
      required: true,
      default: "live",
    },

    // Curriculum
    curriculum: [chapterSchema],

    // Pricing
    price: { type: Number, default: 0 },           // per class / flat
    currency: { type: String, default: "USD" },
    isFree: { type: Boolean, default: false },
    discount: { type: Number, default: 0, min: 0, max: 100 }, // percentage

    // Duration / schedule
    totalClasses: { type: Number, default: 0 },     // for live courses
    durationMinutes: { type: Number, default: 60 }, // per session (live)
    estimatedHours: { type: Number, default: 0 },   // total content hours

    // Status
    status: {
      type: String,
      enum: ["draft", "published", "archived", "under_review"],
      default: "draft",
      index: true,
    },
    publishedAt: { type: Date },

    // Capacity
    maxStudents: { type: Number, default: null },   // null = unlimited
    enrolledCount: { type: Number, default: 0 },

    // Requirements / outcomes
    requirements: [{ type: String }],
    learningOutcomes: [{ type: String }],

    // Reviews (lightweight — separate Review model can be added later)
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingsCount: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ── Auto-generate slug from title ────────────────────────────
courseSchema.pre("save", function (next) {
  if (this.isModified("title") && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .substring(0, 80);
  }
  next();
});

// ── Indexes ───────────────────────────────────────────────────
courseSchema.index({ organisationId: 1, status: 1 });
courseSchema.index({ instructorId: 1, organisationId: 1 });
courseSchema.index({ title: "text", description: "text", tags: "text" });

export const Course = mongoose.model("Course", courseSchema);