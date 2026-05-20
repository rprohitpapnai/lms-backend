import mongoose from "mongoose";
import { Course } from "../models/course.models.js";
import { Enrollment } from "../models/enrollment.models.js";
import { Session } from "../models/session.models.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { uploadOnCloudinary } from "../utils/cloudinary.utils.js";
import { getPagination } from "../utils/pagination.utils.js";
import { isValidObjectId } from "../utils/validation.utils.js";

// ═══════════════════════════════════════════════════════════════
//  PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Throws 400 if id is not a valid ObjectId */
const _assertValidId = (id, label = "ID") => {
  if (!isValidObjectId(id)) throw new ApiError(400, `Invalid ${label}`);
};

/** Throws 404 if course not found */
const _findCourse = async (courseId, orgId = null) => {
  const filter = { _id: courseId };
  if (orgId) filter.organisationId = orgId;
  const course = await Course.findOne(filter);
  if (!course) throw new ApiError(404, "Course not found");
  return course;
};

/** Only instructor assigned to course, admin, or superadmin may mutate */
const _assertCourseWriteAccess = (user, course) => {
  const isSuperAdmin = user.role === "superadmin";
  const isAdmin = user.role === "admin";
  const isAssignedInstructor =
    course.instructorId.toString() === user._id.toString();

  if (!isSuperAdmin && !isAdmin && !isAssignedInstructor) {
    throw new ApiError(403, "You do not have permission to modify this course");
  }
};

// ═══════════════════════════════════════════════════════════════
//  SECTION 1 ─ CORE COURSE CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * CREATE COURSE
 * POST /api/v1/courses
 * Protected – admin / superadmin / instructor
 */
const createCourse = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    shortDescription,
    category,
    level,
    language,
    courseType,
    price,
    currency,
    isFree,
    discount,
    totalClasses,
    durationMinutes,
    estimatedHours,
    maxStudents,
    tags,
    requirements,
    learningOutcomes,
    instructorId,
  } = req.body;

  if (!title || !description || !category) {
    throw new ApiError(400, "title, description, and category are required");
  }

  // Resolve which instructor owns this course
  let assignedInstructor = instructorId || req.user._id.toString();

  // Only admin/superadmin can create a course and assign a different instructor
  if (
    instructorId &&
    instructorId !== req.user._id.toString() &&
    !["admin", "superadmin"].includes(req.user.role)
  ) {
    throw new ApiError(403, "Only admins can assign a course to another instructor");
  }

  // Verify instructor belongs to this org and has the right role
  const instructor = await User.findOne({
    _id: assignedInstructor,
    organizationId: req.user.organizationId,
    role: { $in: ["instructor", "admin", "superadmin"] },
  });
  if (!instructor) {
    throw new ApiError(404, "Instructor not found in your organization");
  }

  const course = await Course.create({
    organisationId: req.user.organizationId,
    instructorId: assignedInstructor,
    createdBy: req.user._id,
    title,
    description,
    shortDescription: shortDescription || "",
    category,
    level: level || "all levels",
    language: language || "English",
    courseType: courseType || "live",
    price: isFree ? 0 : (price || 0),
    currency: currency || "USD",
    isFree: isFree || false,
    discount: discount || 0,
    totalClasses: totalClasses || 0,
    durationMinutes: durationMinutes || 60,
    estimatedHours: estimatedHours || 0,
    maxStudents: maxStudents || null,
    tags: tags || [],
    requirements: requirements || [],
    learningOutcomes: learningOutcomes || [],
    status: "draft",
  });

  return res
    .status(201)
    .json(new ApiResponse(201, "Course created successfully", course));
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL COURSES  (within org – admin/instructor view)
 * GET /api/v1/courses?page=1&limit=10&status=&category=&search=&instructorId=
 * Protected – verifyToken
 */
const getAllCourses = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    status,
    category,
    search,
    instructorId,
    level,
    courseType,
    isFree,
  } = req.query;

  const { skip, ...pagination } = getPagination(page, limit);

  const filter = { organisationId: req.user.organizationId };

  // Students only see published courses
  if (req.user.role === "student") {
    filter.status = "published";
    filter.isActive = true;
  } else {
    if (status) filter.status = status;
  }

  // Instructor only sees their own courses
  if (req.user.role === "instructor") {
    filter.instructorId = req.user._id;
  } else if (instructorId) {
    _assertValidId(instructorId, "instructor ID");
    filter.instructorId = new mongoose.Types.ObjectId(instructorId);
  }

  if (category) filter.category = { $regex: category, $options: "i" };
  if (level) filter.level = level;
  if (courseType) filter.courseType = courseType;
  if (isFree !== undefined) filter.isFree = isFree === "true";

  if (search) {
    filter.$text = { $search: search };
  }

  const [courses, total] = await Promise.all([
    Course.find(filter)
      .select("-curriculum")
      .populate("instructorId", "name email avatar")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    Course.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Courses fetched successfully", {
      courses,
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
 * GET COURSE BY ID  (full detail with curriculum)
 * GET /api/v1/courses/:courseId
 * Protected – verifyToken
 */
const getCourseById = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await Course.findOne({
    _id: courseId,
    organisationId: req.user.organizationId,
  })
    .populate("instructorId", "name email avatar")
    .populate("createdBy", "name email");

  if (!course) throw new ApiError(404, "Course not found");

  // Students can only access published courses
  if (req.user.role === "student" && course.status !== "published") {
    throw new ApiError(403, "This course is not available");
  }

  // For students, hide lessons that are not free previews (if not enrolled)
  let courseData = course.toObject();
  if (req.user.role === "student") {
    const isEnrolled = await Enrollment.exists({
      studentId: req.user._id,
      courseId: course._id,
      status: "active",
    });

    if (!isEnrolled) {
      // Mask locked lessons for non-enrolled students
      courseData.curriculum = courseData.curriculum.map((chapter) => ({
        ...chapter,
        lessons: chapter.lessons.map((lesson) => ({
          _id: lesson._id,
          title: lesson.title,
          duration: lesson.duration,
          isFreePreview: lesson.isFreePreview,
          order: lesson.order,
          // Only expose video if it's a free preview
          ...(lesson.isFreePreview ? { videoUrl: lesson.videoUrl } : {}),
        })),
      }));
    }
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Course fetched successfully", courseData));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE COURSE  (metadata only – not curriculum)
 * PATCH /api/v1/courses/:courseId
 * Protected – instructor (own) / admin / superadmin
 */
const updateCourse = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const allowedFields = [
    "title", "description", "shortDescription", "category",
    "level", "language", "courseType", "price", "currency",
    "isFree", "discount", "totalClasses", "durationMinutes",
    "estimatedHours", "maxStudents", "tags",
    "requirements", "learningOutcomes",
  ];

  const updateFields = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateFields[field] = req.body[field];
    }
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  // If isFree toggled on, force price to 0
  if (updateFields.isFree === true) updateFields.price = 0;

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: updateFields },
    { new: true, runValidators: true }
  ).populate("instructorId", "name email");

  return res
    .status(200)
    .json(new ApiResponse(200, "Course updated successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * DELETE COURSE
 * DELETE /api/v1/courses/:courseId
 * Protected – admin / superadmin
 */
const deleteCourse = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);

  // Check for active enrollments
  const activeEnrollments = await Enrollment.countDocuments({
    courseId: course._id,
    status: "active",
  });

  if (activeEnrollments > 0) {
    throw new ApiError(
      400,
      `Cannot delete course with ${activeEnrollments} active enrollment(s). Archive it instead.`
    );
  }

  await Course.findByIdAndDelete(courseId);

  return res
    .status(200)
    .json(new ApiResponse(200, "Course deleted successfully", { courseId }));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 2 ─ STATUS LIFECYCLE
// ═══════════════════════════════════════════════════════════════

/**
 * PUBLISH COURSE
 * PATCH /api/v1/courses/:courseId/publish
 * Protected – instructor (own) / admin / superadmin
 */
const publishCourse = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  if (course.status === "published") {
    throw new ApiError(400, "Course is already published");
  }

  // Basic readiness check
  if (!course.title || !course.description || !course.category) {
    throw new ApiError(
      400,
      "Course must have a title, description, and category before publishing"
    );
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { status: "published", publishedAt: new Date() } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Course published successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * UNPUBLISH COURSE  (back to draft)
 * PATCH /api/v1/courses/:courseId/unpublish
 * Protected – instructor (own) / admin / superadmin
 */
const unpublishCourse = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  if (course.status !== "published") {
    throw new ApiError(400, "Course is not currently published");
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { status: "draft" } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Course unpublished (moved to draft)", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * ARCHIVE COURSE
 * PATCH /api/v1/courses/:courseId/archive
 * Protected – admin / superadmin
 */
const archiveCourse = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);

  if (course.status === "archived") {
    throw new ApiError(400, "Course is already archived");
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { status: "archived", isActive: false } },
    { new: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Course archived successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 3 ─ MEDIA UPLOADS
// ═══════════════════════════════════════════════════════════════

/**
 * UPLOAD COURSE THUMBNAIL
 * PATCH /api/v1/courses/:courseId/thumbnail
 * Protected – instructor (own) / admin / superadmin  +  multer
 */
const uploadCourseThumbnail = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const localPath = req.file?.path;
  if (!localPath) throw new ApiError(400, "Thumbnail file is required");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const uploaded = await uploadOnCloudinary(
    localPath,
    `lms/${req.user.organizationId}/courses/${courseId}/thumbnails`
  );
  if (!uploaded?.url) throw new ApiError(500, "Failed to upload thumbnail");

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { thumbnail: uploaded.url } },
    { new: true }
  ).select("title thumbnail");

  return res
    .status(200)
    .json(new ApiResponse(200, "Thumbnail uploaded successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPLOAD COURSE PREVIEW VIDEO
 * PATCH /api/v1/courses/:courseId/preview-video
 * Protected – instructor (own) / admin / superadmin  +  multer
 */
const uploadCoursePreviewVideo = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const localPath = req.file?.path;
  if (!localPath) throw new ApiError(400, "Preview video file is required");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const uploaded = await uploadOnCloudinary(
    localPath,
    `lms/${req.user.organizationId}/courses/${courseId}/preview`
  );
  if (!uploaded?.url) throw new ApiError(500, "Failed to upload preview video");

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { previewVideoUrl: uploaded.url } },
    { new: true }
  ).select("title previewVideoUrl");

  return res
    .status(200)
    .json(new ApiResponse(200, "Preview video uploaded successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 4 ─ CURRICULUM (Chapters & Lessons)
// ═══════════════════════════════════════════════════════════════

/**
 * ADD CHAPTER
 * POST /api/v1/courses/:courseId/chapters
 * Protected – instructor (own) / admin / superadmin
 */
const addChapter = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { title, description, order } = req.body;
  _assertValidId(courseId, "course ID");

  if (!title) throw new ApiError(400, "Chapter title is required");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const newChapter = {
    title,
    description: description || "",
    order: order ?? course.curriculum.length,
    lessons: [],
  };

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $push: { curriculum: newChapter } },
    { new: true }
  ).select("curriculum");

  return res
    .status(201)
    .json(new ApiResponse(201, "Chapter added successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE CHAPTER
 * PATCH /api/v1/courses/:courseId/chapters/:chapterId
 * Protected – instructor (own) / admin / superadmin
 */
const updateChapter = asyncHandler(async (req, res) => {
  const { courseId, chapterId } = req.params;
  const { title, description, order } = req.body;
  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const setFields = {};
  if (title !== undefined)       setFields["curriculum.$[ch].title"] = title;
  if (description !== undefined) setFields["curriculum.$[ch].description"] = description;
  if (order !== undefined)       setFields["curriculum.$[ch].order"] = order;

  if (Object.keys(setFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: setFields },
    {
      new: true,
      arrayFilters: [{ "ch._id": new mongoose.Types.ObjectId(chapterId) }],
    }
  ).select("curriculum");

  return res
    .status(200)
    .json(new ApiResponse(200, "Chapter updated successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * DELETE CHAPTER
 * DELETE /api/v1/courses/:courseId/chapters/:chapterId
 * Protected – instructor (own) / admin / superadmin
 */
const deleteChapter = asyncHandler(async (req, res) => {
  const { courseId, chapterId } = req.params;
  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $pull: { curriculum: { _id: new mongoose.Types.ObjectId(chapterId) } } },
    { new: true }
  ).select("curriculum");

  return res
    .status(200)
    .json(new ApiResponse(200, "Chapter deleted successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * ADD LESSON  to a chapter
 * POST /api/v1/courses/:courseId/chapters/:chapterId/lessons
 * Protected – instructor (own) / admin / superadmin
 */
const addLesson = asyncHandler(async (req, res) => {
  const { courseId, chapterId } = req.params;
  const { title, description, videoUrl, duration, isFreePreview, order, attachments } =
    req.body;

  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");

  if (!title) throw new ApiError(400, "Lesson title is required");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const chapter = course.curriculum.id(chapterId);
  if (!chapter) throw new ApiError(404, "Chapter not found");

  const newLesson = {
    title,
    description: description || "",
    videoUrl: videoUrl || "",
    duration: duration || 0,
    isFreePreview: isFreePreview || false,
    order: order ?? chapter.lessons.length,
    attachments: attachments || [],
  };

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $push: { "curriculum.$[ch].lessons": newLesson } },
    {
      new: true,
      arrayFilters: [{ "ch._id": new mongoose.Types.ObjectId(chapterId) }],
    }
  ).select("curriculum");

  return res
    .status(201)
    .json(new ApiResponse(201, "Lesson added successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE LESSON
 * PATCH /api/v1/courses/:courseId/chapters/:chapterId/lessons/:lessonId
 * Protected – instructor (own) / admin / superadmin
 */
const updateLesson = asyncHandler(async (req, res) => {
  const { courseId, chapterId, lessonId } = req.params;
  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");
  _assertValidId(lessonId, "lesson ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const allowedLessonFields = [
    "title", "description", "videoUrl", "duration", "isFreePreview", "order", "attachments",
  ];

  const setFields = {};
  for (const field of allowedLessonFields) {
    if (req.body[field] !== undefined) {
      setFields[`curriculum.$[ch].lessons.$[ls].${field}`] = req.body[field];
    }
  }

  if (Object.keys(setFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: setFields },
    {
      new: true,
      arrayFilters: [
        { "ch._id": new mongoose.Types.ObjectId(chapterId) },
        { "ls._id": new mongoose.Types.ObjectId(lessonId) },
      ],
    }
  ).select("curriculum");

  return res
    .status(200)
    .json(new ApiResponse(200, "Lesson updated successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * DELETE LESSON
 * DELETE /api/v1/courses/:courseId/chapters/:chapterId/lessons/:lessonId
 * Protected – instructor (own) / admin / superadmin
 */
const deleteLesson = asyncHandler(async (req, res) => {
  const { courseId, chapterId, lessonId } = req.params;
  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");
  _assertValidId(lessonId, "lesson ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const updated = await Course.findByIdAndUpdate(
    courseId,
    {
      $pull: {
        "curriculum.$[ch].lessons": { _id: new mongoose.Types.ObjectId(lessonId) },
      },
    },
    {
      new: true,
      arrayFilters: [{ "ch._id": new mongoose.Types.ObjectId(chapterId) }],
    }
  ).select("curriculum");

  return res
    .status(200)
    .json(new ApiResponse(200, "Lesson deleted successfully", updated.curriculum));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPLOAD LESSON VIDEO
 * PATCH /api/v1/courses/:courseId/chapters/:chapterId/lessons/:lessonId/video
 * Protected – instructor (own) / admin / superadmin  +  multer
 */
const uploadLessonVideo = asyncHandler(async (req, res) => {
  const { courseId, chapterId, lessonId } = req.params;
  _assertValidId(courseId, "course ID");
  _assertValidId(chapterId, "chapter ID");
  _assertValidId(lessonId, "lesson ID");

  const localPath = req.file?.path;
  if (!localPath) throw new ApiError(400, "Video file is required");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const uploaded = await uploadOnCloudinary(
    localPath,
    `lms/${req.user.organizationId}/courses/${courseId}/lessons`
  );
  if (!uploaded?.url) throw new ApiError(500, "Failed to upload lesson video");

  const updated = await Course.findByIdAndUpdate(
    courseId,
    {
      $set: {
        "curriculum.$[ch].lessons.$[ls].videoUrl": uploaded.url,
        "curriculum.$[ch].lessons.$[ls].duration": uploaded.duration
          ? Math.round(uploaded.duration)
          : 0,
      },
    },
    {
      new: true,
      arrayFilters: [
        { "ch._id": new mongoose.Types.ObjectId(chapterId) },
        { "ls._id": new mongoose.Types.ObjectId(lessonId) },
      ],
    }
  ).select("curriculum");

  return res
    .status(200)
    .json(new ApiResponse(200, "Lesson video uploaded successfully", updated.curriculum));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 5 ─ INSTRUCTOR MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * ASSIGN INSTRUCTOR TO COURSE
 * PATCH /api/v1/courses/:courseId/assign-instructor
 * Protected – admin / superadmin
 */
const assignInstructor = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { instructorId } = req.body;

  _assertValidId(courseId, "course ID");
  _assertValidId(instructorId, "instructor ID");

  const course = await _findCourse(courseId, req.user.organizationId);

  const instructor = await User.findOne({
    _id: instructorId,
    organizationId: req.user.organizationId,
    role: { $in: ["instructor", "admin", "superadmin"] },
  });
  if (!instructor) {
    throw new ApiError(404, "Instructor not found in your organization");
  }

  const updated = await Course.findByIdAndUpdate(
    courseId,
    { $set: { instructorId } },
    { new: true }
  ).populate("instructorId", "name email avatar");

  return res
    .status(200)
    .json(new ApiResponse(200, "Instructor assigned successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 6 ─ ENROLLMENTS (course-scoped views)
// ═══════════════════════════════════════════════════════════════

/**
 * GET COURSE ENROLLMENTS
 * GET /api/v1/courses/:courseId/enrollments?page=1&limit=10&status=
 * Protected – instructor (own) / admin / superadmin
 */
const getCourseEnrollments = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { status, page, limit } = req.query;

  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const { skip, ...pagination } = getPagination(page, limit);

  const filter = { courseId: course._id };
  if (status) filter.status = status;

  const [enrollments, total] = await Promise.all([
    Enrollment.find(filter)
      .populate("studentId", "name email username avatar")
      .populate("teacherId", "name email")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    Enrollment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Enrollments fetched successfully", {
      enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ENROLLED STUDENTS  (lightweight list)
 * GET /api/v1/courses/:courseId/students
 * Protected – instructor (own) / admin / superadmin
 */
const getCourseStudents = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const { skip, ...pagination } = getPagination(req.query.page, req.query.limit);

  const [enrollments, total] = await Promise.all([
    Enrollment.find({ courseId: course._id, status: "active" })
      .populate("studentId", "name email username avatar phoneNumber")
      .select("studentId totalClasses remainingClasses paidAmount totalAmount status planType")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    Enrollment.countDocuments({ courseId: course._id, status: "active" }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Course students fetched successfully", {
      students: enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 7 ─ SESSIONS (course-scoped)
// ═══════════════════════════════════════════════════════════════

/**
 * GET COURSE SESSIONS
 * GET /api/v1/courses/:courseId/sessions?status=&from=&to=&page=&limit=
 * Protected – instructor (own) / admin / superadmin
 */
const getCourseSessions = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { status, from, to, page, limit } = req.query;

  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);

  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    courseId: course._id,
    organisationId: req.user.organizationId,
  };
  if (status) filter.status = status;
  if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to) filter.startTime.$lte = new Date(to);
  }

  const [sessions, total] = await Promise.all([
    Session.find(filter)
      .populate("studentId", "name email avatar")
      .populate("teacherId", "name email")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ startTime: 1 }),
    Session.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Sessions fetched successfully", {
      sessions,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 8 ─ ANALYTICS
// ═══════════════════════════════════════════════════════════════

/**
 * GET COURSE ANALYTICS
 * GET /api/v1/courses/:courseId/analytics
 * Protected – instructor (own) / admin / superadmin
 */
const getCourseAnalytics = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  _assertValidId(courseId, "course ID");

  const course = await _findCourse(courseId, req.user.organizationId);
  _assertCourseWriteAccess(req.user, course);

  const courseObjectId = course._id;

  const [enrollmentStats, sessionStats, revenueStats, recentStudents] =
    await Promise.all([
      // Enrollment breakdown by status
      Enrollment.aggregate([
        { $match: { courseId: courseObjectId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Session breakdown by status
      Session.aggregate([
        { $match: { courseId: courseObjectId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),

      // Revenue
      Enrollment.aggregate([
        { $match: { courseId: courseObjectId } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$totalAmount" },
            paidAmount: { $sum: "$paidAmount" },
            pendingAmount: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
          },
        },
      ]),

      // 5 most recent active students
      Enrollment.find({ courseId: courseObjectId, status: "active" })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("studentId", "name email avatar"),
    ]);

  const enrollmentByStatus = {};
  enrollmentStats.forEach(({ _id, count }) => {
    enrollmentByStatus[_id] = count;
  });

  const sessionByStatus = {};
  sessionStats.forEach(({ _id, count }) => {
    sessionByStatus[_id] = count;
  });

  const revenue = revenueStats[0] || {
    totalAmount: 0,
    paidAmount: 0,
    pendingAmount: 0,
  };

  const totalEnrollments = Object.values(enrollmentByStatus).reduce(
    (sum, c) => sum + c,
    0
  );

  const completionRate =
    totalEnrollments > 0
      ? (
          ((enrollmentByStatus["completed"] || 0) / totalEnrollments) *
          100
        ).toFixed(1)
      : "0.0";

  return res.status(200).json(
    new ApiResponse(200, "Course analytics fetched successfully", {
      course: {
        _id: course._id,
        title: course.title,
        status: course.status,
        enrolledCount: course.enrolledCount,
        rating: course.rating,
        ratingsCount: course.ratingsCount,
      },
      enrollments: {
        byStatus: enrollmentByStatus,
        total: totalEnrollments,
        completionRate: `${completionRate}%`,
      },
      sessions: {
        byStatus: sessionByStatus,
        total: Object.values(sessionByStatus).reduce((sum, c) => sum + c, 0),
      },
      revenue,
      recentStudents,
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL COURSES ANALYTICS  (org-level dashboard)
 * GET /api/v1/courses/analytics/summary
 * Protected – admin / superadmin
 */
const getCoursesSummaryAnalytics = asyncHandler(async (req, res) => {
  const orgId = new mongoose.Types.ObjectId(req.user.organizationId);

  const [courseStats, topCourses, enrollmentTrend] = await Promise.all([
    // Courses breakdown by status
    Course.aggregate([
      { $match: { organisationId: orgId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Top 5 courses by enrolledCount
    Course.find({ organisationId: orgId })
      .sort({ enrolledCount: -1 })
      .limit(5)
      .select("title enrolledCount rating status thumbnail")
      .populate("instructorId", "name"),

    // Monthly enrollment trend (last 6 months)
    Enrollment.aggregate([
      { $match: { organisationId: orgId } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          enrollments: { $sum: 1 },
          revenue: { $sum: "$paidAmount" },
        },
      },
      { $sort: { "_id.year": -1, "_id.month": -1 } },
      { $limit: 6 },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
  ]);

  const byStatus = {};
  courseStats.forEach(({ _id, count }) => {
    byStatus[_id] = count;
  });

  return res.status(200).json(
    new ApiResponse(200, "Courses summary analytics fetched successfully", {
      coursesByStatus: byStatus,
      totalCourses: Object.values(byStatus).reduce((sum, c) => sum + c, 0),
      topCourses,
      enrollmentTrend,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export {
  // Core CRUD
  createCourse,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,

  // Status lifecycle
  publishCourse,
  unpublishCourse,
  archiveCourse,

  // Media
  uploadCourseThumbnail,
  uploadCoursePreviewVideo,

  // Curriculum
  addChapter,
  updateChapter,
  deleteChapter,
  addLesson,
  updateLesson,
  deleteLesson,
  uploadLessonVideo,

  // Instructor
  assignInstructor,

  // Enrollments (course-scoped)
  getCourseEnrollments,
  getCourseStudents,

  // Sessions (course-scoped)
  getCourseSessions,

  // Analytics
  getCourseAnalytics,
  getCoursesSummaryAnalytics,
};
