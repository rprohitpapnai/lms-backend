import mongoose from "mongoose";
import { Organisation } from "../models/organisation.models.js";
import { User } from "../models/user.model.js";
import { Enrollment } from "../models/enrollment.models.js";
import { Payment } from "../models/payments.models.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { uploadOnCloudinary } from "../utils/cloudinary.utils.js";
import { getPagination } from "../utils/pagination.utils.js";

// ═══════════════════════════════════════════════════════════════
//  SECTION 1 ─ CORE CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * CREATE ORGANIZATION
 * POST /api/v1/organisations
 * Only superadmin can create organizations
 */
const createOrganization = asyncHandler(async (req, res) => {
  const {
    name,
    plan = "free",
    contactEmail,
    website,
    address,
    timezone,
    language,
    currency,
  } = req.body;

  if (!name) {
    throw new ApiError(400, "Organization name is required");
  }

  // Check name uniqueness
  const existing = await Organisation.findOne({
    name: { $regex: `^${name}$`, $options: "i" },
  });
  if (existing) {
    throw new ApiError(409, "An organization with this name already exists");
  }

  const validPlans = ["free", "premium", "enterprise", "custom"];
  if (!validPlans.includes(plan)) {
    throw new ApiError(400, `Invalid plan. Allowed: ${validPlans.join(", ")}`);
  }

  const planStartDate = new Date();
  // Default: free = 30 days trial, others = 1 year
  const planEndDate = new Date();
  planEndDate.setFullYear(
    planEndDate.getFullYear() + (plan === "free" ? 0 : 1)
  );
  if (plan === "free") planEndDate.setDate(planEndDate.getDate() + 30);

  const organisation = await Organisation.create({
    owner: req.user._id,
    name,
    plan,
    planStartDate,
    planEndDate,
    planStatus: true,
    admins: [req.user._id],
    settings: {
      contactEmail: contactEmail || "",
      website: website || "",
      address: address || "",
      timezone: timezone || "UTC",
      language: language || "en",
      currency: currency || "USD",
    },
    subscriptionHistory: [
      {
        plan,
        startDate: planStartDate,
        endDate: planEndDate,
        changedAt: new Date(),
        changedBy: req.user._id,
      },
    ],
  });

  // Assign the creator to this org
  await User.findByIdAndUpdate(req.user._id, {
    $set: { organizationId: organisation._id },
  });

  return res
    .status(201)
    .json(
      new ApiResponse(201, "Organization created successfully", organisation)
    );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ORGANIZATION BY ID
 * GET /api/v1/organisations/:orgId
 * Protected – admin / superadmin
 */
const getOrganizationById = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Invalid organization ID");
  }

  const organisation = await Organisation.findById(orgId)
    .populate("owner", "name email username")
    .populate("admins", "name email username role");

  if (!organisation) {
    throw new ApiError(404, "Organization not found");
  }

  // Non-superadmin can only view their own org
  if (
    req.user.role !== "superadmin" &&
    organisation._id.toString() !== req.user.organizationId?.toString()
  ) {
    throw new ApiError(403, "Access denied to this organization");
  }

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Organization fetched successfully", organisation)
    );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL ORGANIZATIONS
 * GET /api/v1/organisations?page=1&limit=10&search=
 * Protected – superadmin only
 */
const getAllOrganizations = asyncHandler(async (req, res) => {
  const { page, limit, search, plan, isActive } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {};

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { "settings.contactEmail": { $regex: search, $options: "i" } },
    ];
  }
  if (plan) filter.plan = plan;
  if (isActive !== undefined) filter.isActive = isActive === "true";

  const [organisations, total] = await Promise.all([
    Organisation.find(filter)
      .populate("owner", "name email")
      .select("-subscriptionHistory")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    Organisation.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Organizations fetched successfully", {
      organisations,
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
 * UPDATE ORGANIZATION  (name, slug, basic info only)
 * PATCH /api/v1/organisations/:orgId
 * Protected – admin / superadmin of that org
 */
const updateOrganization = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { name, isActive } = req.body;

  const organisation = await Organisation.findById(orgId);
  if (!organisation) throw new ApiError(404, "Organization not found");

  // Authorization: must be owner, an admin of this org, or superadmin
  const isOwner = organisation.owner.toString() === req.user._id.toString();
  const isOrgAdmin = organisation.admins
    .map((a) => a.toString())
    .includes(req.user._id.toString());

  if (!isOwner && !isOrgAdmin && req.user.role !== "superadmin") {
    throw new ApiError(403, "You do not have permission to update this organization");
  }

  const updateFields = {};
  if (name) {
    // Ensure name uniqueness
    const conflict = await Organisation.findOne({
      name: { $regex: `^${name}$`, $options: "i" },
      _id: { $ne: orgId },
    });
    if (conflict) throw new ApiError(409, "Organization name already in use");
    updateFields.name = name;
    // Reset slug when name changes
    updateFields.slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  // Only superadmin can toggle isActive
  if (typeof isActive === "boolean") {
    if (req.user.role !== "superadmin") {
      throw new ApiError(403, "Only superadmins can activate/deactivate an organization");
    }
    updateFields.isActive = isActive;
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    { $set: updateFields },
    { new: true, runValidators: true }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Organization updated successfully", updated));
});

// ─────────────────────────────────────────────────────────────
/**
 * DELETE ORGANIZATION
 * DELETE /api/v1/organisations/:orgId
 * Protected – superadmin only
 */
const deleteOrganization = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  const organisation = await Organisation.findById(orgId);
  if (!organisation) throw new ApiError(404, "Organization not found");

  // Cascade: unlink all users from this org
  await User.updateMany(
    { organizationId: orgId },
    { $unset: { organizationId: 1 } }
  );

  await Organisation.findByIdAndDelete(orgId);

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Organization deleted successfully", { orgId })
    );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 2 ─ ORGANIZATION USERS
// ═══════════════════════════════════════════════════════════════

// Shared helper to fetch users within an org filtered by role
const _getOrgUsersByRole = async (orgId, roles, query) => {
  const { page, limit, search } = query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = { organizationId: orgId };
  if (roles && roles.length > 0) filter.role = { $in: roles };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { username: { $regex: search, $options: "i" } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-password -refreshToken")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: {
      ...pagination,
      total,
      totalPages: Math.ceil(total / pagination.limit),
    },
  };
};

/**
 * GET ORGANIZATION USERS  (all roles)
 * GET /api/v1/organisations/:orgId/users
 * Protected – admin / superadmin
 */
const getOrganizationUsers = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId);

  const data = await _getOrgUsersByRole(orgId, [], req.query);

  return res
    .status(200)
    .json(new ApiResponse(200, "Users fetched successfully", data));
});

/**
 * GET ORGANIZATION TEACHERS
 * GET /api/v1/organisations/:orgId/teachers
 * Protected – admin / superadmin
 */
const getOrganizationTeachers = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId);

  const data = await _getOrgUsersByRole(orgId, ["instructor"], req.query);

  return res
    .status(200)
    .json(new ApiResponse(200, "Teachers fetched successfully", data));
});

/**
 * GET ORGANIZATION STUDENTS
 * GET /api/v1/organisations/:orgId/students
 * Protected – admin / superadmin / instructor
 */
const getOrganizationStudents = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId, ["admin", "superadmin", "instructor"]);

  const data = await _getOrgUsersByRole(orgId, ["student"], req.query);

  return res
    .status(200)
    .json(new ApiResponse(200, "Students fetched successfully", data));
});

/**
 * GET ORGANIZATION ADMINS
 * GET /api/v1/organisations/:orgId/admins
 * Protected – admin / superadmin
 */
const getOrganizationAdmins = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId);

  const data = await _getOrgUsersByRole(orgId, ["admin", "superadmin"], req.query);

  return res
    .status(200)
    .json(new ApiResponse(200, "Admins fetched successfully", data));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 3 ─ SETTINGS & LOGO
// ═══════════════════════════════════════════════════════════════

/**
 * UPDATE ORGANIZATION SETTINGS
 * PATCH /api/v1/organisations/:orgId/settings
 * Protected – admin / superadmin
 */
const updateOrganizationSettings = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const {
    allowStudentSelfRegister,
    maxStudents,
    maxTeachers,
    timezone,
    language,
    currency,
    contactEmail,
    website,
    address,
  } = req.body;

  await _assertOrgAccess(req.user, orgId);

  const settingsUpdate = {};
  const fields = {
    allowStudentSelfRegister,
    maxStudents,
    maxTeachers,
    timezone,
    language,
    currency,
    contactEmail,
    website,
    address,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) settingsUpdate[`settings.${key}`] = value;
  }

  if (Object.keys(settingsUpdate).length === 0) {
    throw new ApiError(400, "Provide at least one setting to update");
  }

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    { $set: settingsUpdate },
    { new: true, runValidators: true }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Settings updated successfully", updated.settings)
    );
});

/**
 * UPLOAD ORGANIZATION LOGO
 * PATCH /api/v1/organisations/:orgId/logo
 * Protected – admin / superadmin  +  multer middleware
 */
const uploadOrganizationLogo = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const logoLocalPath = req.file?.path;

  if (!logoLocalPath) {
    throw new ApiError(400, "Logo file is required");
  }

  await _assertOrgAccess(req.user, orgId);

  const uploaded = await uploadOnCloudinary(
    logoLocalPath,
    `lms/${orgId}/logos`
  );

  if (!uploaded?.url) {
    throw new ApiError(500, "Failed to upload logo. Please try again.");
  }

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    { $set: { logo: uploaded.url } },
    { new: true }
  ).select("name logo");

  return res
    .status(200)
    .json(new ApiResponse(200, "Logo uploaded successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 4 ─ SUBSCRIPTION / PLAN MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const PLAN_DURATIONS = {
  free: 30,        // days
  premium: 365,
  enterprise: 365,
  custom: 365,
};

/**
 * SUBSCRIBE ORGANIZATION PLAN  (first-time or re-subscribe from cancelled)
 * POST /api/v1/organisations/:orgId/subscribe
 * Protected – superadmin
 */
const subscribeOrganizationPlan = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { plan } = req.body;

  const validPlans = ["free", "premium", "enterprise", "custom"];
  if (!plan || !validPlans.includes(plan)) {
    throw new ApiError(400, `Plan must be one of: ${validPlans.join(", ")}`);
  }

  const organisation = await Organisation.findById(orgId);
  if (!organisation) throw new ApiError(404, "Organization not found");

  if (organisation.planStatus && !organisation.isCancelled) {
    throw new ApiError(
      400,
      "Organization already has an active plan. Use upgrade or cancel first."
    );
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + PLAN_DURATIONS[plan]);

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    {
      $set: {
        plan,
        planStartDate: startDate,
        planEndDate: endDate,
        planStatus: true,
        isCancelled: false,
      },
      $push: {
        subscriptionHistory: {
          plan,
          startDate,
          endDate,
          changedAt: new Date(),
          changedBy: req.user._id,
        },
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, `Subscribed to '${plan}' plan successfully`, {
        plan: updated.plan,
        planStartDate: updated.planStartDate,
        planEndDate: updated.planEndDate,
        planStatus: updated.planStatus,
      })
    );
});

/**
 * UPGRADE ORGANIZATION PLAN
 * PATCH /api/v1/organisations/:orgId/upgrade
 * Protected – superadmin
 */
const upgradeOrganizationPlan = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { plan } = req.body;

  const planHierarchy = ["free", "premium", "enterprise", "custom"];

  const organisation = await Organisation.findById(orgId);
  if (!organisation) throw new ApiError(404, "Organization not found");

  const currentIndex = planHierarchy.indexOf(organisation.plan);
  const newIndex = planHierarchy.indexOf(plan);

  if (newIndex === -1) {
    throw new ApiError(400, `Invalid plan. Allowed: ${planHierarchy.join(", ")}`);
  }

  if (newIndex <= currentIndex) {
    throw new ApiError(
      400,
      `Cannot downgrade via upgrade. Current plan: '${organisation.plan}'. Use a plan above it.`
    );
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + PLAN_DURATIONS[plan]);

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    {
      $set: {
        plan,
        planStartDate: startDate,
        planEndDate: endDate,
        planStatus: true,
        isCancelled: false,
      },
      $push: {
        subscriptionHistory: {
          plan,
          startDate,
          endDate,
          changedAt: new Date(),
          changedBy: req.user._id,
        },
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, `Plan upgraded to '${plan}' successfully`, {
        plan: updated.plan,
        planStartDate: updated.planStartDate,
        planEndDate: updated.planEndDate,
      })
    );
});

/**
 * CANCEL ORGANIZATION SUBSCRIPTION
 * PATCH /api/v1/organisations/:orgId/cancel-subscription
 * Protected – superadmin
 */
const cancelOrganizationSubscription = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  const organisation = await Organisation.findById(orgId);
  if (!organisation) throw new ApiError(404, "Organization not found");

  if (!organisation.planStatus || organisation.isCancelled) {
    throw new ApiError(400, "No active subscription to cancel");
  }

  const updated = await Organisation.findByIdAndUpdate(
    orgId,
    {
      $set: {
        planStatus: false,
        isCancelled: true,
      },
    },
    { new: true }
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, "Subscription cancelled successfully", {
        plan: updated.plan,
        planStatus: updated.planStatus,
        isCancelled: updated.isCancelled,
      })
    );
});

/**
 * GET ORGANIZATION SUBSCRIPTION  (plan info + history)
 * GET /api/v1/organisations/:orgId/subscription
 * Protected – admin / superadmin
 */
const getOrganizationSubscription = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId);

  const organisation = await Organisation.findById(orgId).select(
    "name plan planStartDate planEndDate planStatus isCancelled subscriptionHistory"
  );

  if (!organisation) throw new ApiError(404, "Organization not found");

  const now = new Date();
  const daysRemaining =
    organisation.planEndDate
      ? Math.max(
          0,
          Math.ceil(
            (organisation.planEndDate - now) / (1000 * 60 * 60 * 24)
          )
        )
      : null;

  return res.status(200).json(
    new ApiResponse(200, "Subscription details fetched", {
      plan: organisation.plan,
      planStartDate: organisation.planStartDate,
      planEndDate: organisation.planEndDate,
      planStatus: organisation.planStatus,
      isCancelled: organisation.isCancelled,
      daysRemaining,
      subscriptionHistory: organisation.subscriptionHistory,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 5 ─ ANALYTICS & REPORTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET ORGANIZATION ANALYTICS  (user counts, enrollment stats)
 * GET /api/v1/organisations/:orgId/analytics
 * Protected – admin / superadmin
 */
const getOrganizationAnalytics = asyncHandler(async (req, res) => {
  const { orgId } = req.params;

  await _assertOrgAccess(req.user, orgId);

  const orgObjectId = new mongoose.Types.ObjectId(orgId);

  const [
    totalUsers,
    totalStudents,
    totalTeachers,
    totalAdmins,
    enrollmentStats,
    recentEnrollments,
  ] = await Promise.all([
    User.countDocuments({ organizationId: orgId }),
    User.countDocuments({ organizationId: orgId, role: "student" }),
    User.countDocuments({ organizationId: orgId, role: "instructor" }),
    User.countDocuments({ organizationId: orgId, role: { $in: ["admin", "superadmin"] } }),

    // Enrollment breakdown by status
    Enrollment.aggregate([
      { $match: { organisationId: orgObjectId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Last 5 enrollments
    Enrollment.find({ organisationId: orgObjectId })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("studentId", "name email")
      .populate("courseId", "title"),
  ]);

  // Format enrollment stats into a map
  const enrollmentByStatus = {};
  enrollmentStats.forEach(({ _id, count }) => {
    enrollmentByStatus[_id] = count;
  });

  return res.status(200).json(
    new ApiResponse(200, "Analytics fetched successfully", {
      users: { total: totalUsers, students: totalStudents, teachers: totalTeachers, admins: totalAdmins },
      enrollments: {
        byStatus: enrollmentByStatus,
        totalEnrollments: enrollmentStats.reduce((acc, e) => acc + e.count, 0),
      },
      recentEnrollments,
    })
  );
});

/**
 * GET ORGANIZATION REVENUE
 * GET /api/v1/organisations/:orgId/revenue?from=&to=
 * Protected – admin / superadmin
 */
const getOrganizationRevenue = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { from, to } = req.query;

  await _assertOrgAccess(req.user, orgId);

  const orgObjectId = new mongoose.Types.ObjectId(orgId);

  // Build date range filter on enrollments
  const enrollmentFilter = { organisationId: orgObjectId };
  if (from || to) {
    enrollmentFilter.createdAt = {};
    if (from) enrollmentFilter.createdAt.$gte = new Date(from);
    if (to) enrollmentFilter.createdAt.$lte = new Date(to);
  }

  const [revenueStats, monthlyRevenue, topCourses] = await Promise.all([
    // Total & collected revenue
    Enrollment.aggregate([
      { $match: enrollmentFilter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$totalAmount" },
          paidAmount: { $sum: "$paidAmount" },
          pendingAmount: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Revenue grouped by month
    Enrollment.aggregate([
      { $match: enrollmentFilter },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          revenue: { $sum: "$paidAmount" },
          enrollments: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // Top 5 revenue-generating courses
    Enrollment.aggregate([
      { $match: enrollmentFilter },
      {
        $group: {
          _id: "$courseId",
          revenue: { $sum: "$paidAmount" },
          enrollments: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "courses",
          localField: "_id",
          foreignField: "_id",
          as: "course",
        },
      },
      { $unwind: { path: "$course", preserveNullAndEmpty: true } },
    ]),
  ]);

  const summary = revenueStats[0] || {
    totalAmount: 0,
    paidAmount: 0,
    pendingAmount: 0,
    count: 0,
  };

  return res.status(200).json(
    new ApiResponse(200, "Revenue fetched successfully", {
      summary,
      monthlyRevenue,
      topCourses,
    })
  );
});

/**
 * GET TEACHER PERFORMANCE
 * GET /api/v1/organisations/:orgId/analytics/teachers?from=&to=
 * Protected – admin / superadmin
 */
const getTeacherPerformance = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { from, to, page, limit } = req.query;

  await _assertOrgAccess(req.user, orgId);

  const orgObjectId = new mongoose.Types.ObjectId(orgId);

  const matchFilter = { organisationId: orgObjectId };
  if (from || to) {
    matchFilter.createdAt = {};
    if (from) matchFilter.createdAt.$gte = new Date(from);
    if (to) matchFilter.createdAt.$lte = new Date(to);
  }

  const { skip, ...pagination } = getPagination(page, limit);

  const performance = await Enrollment.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: "$teacherId",
        totalStudents: { $addToSet: "$studentId" },
        totalEnrollments: { $sum: 1 },
        totalRevenue: { $sum: "$paidAmount" },
        completedClasses: {
          $sum: {
            $subtract: ["$totalClasses", "$remainingClasses"],
          },
        },
        activeEnrollments: {
          $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
        },
        completedEnrollments: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
      },
    },
    {
      $project: {
        teacherId: "$_id",
        totalStudents: { $size: "$totalStudents" },
        totalEnrollments: 1,
        totalRevenue: 1,
        completedClasses: 1,
        activeEnrollments: 1,
        completedEnrollments: 1,
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "teacher",
      },
    },
    { $unwind: "$teacher" },
    {
      $project: {
        "teacher.password": 0,
        "teacher.refreshToken": 0,
      },
    },
    { $sort: { totalRevenue: -1 } },
    { $skip: skip },
    { $limit: pagination.limit },
  ]);

  const total = await Enrollment.distinct("teacherId", matchFilter).then(
    (arr) => arr.length
  );

  return res.status(200).json(
    new ApiResponse(200, "Teacher performance fetched successfully", {
      performance,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

/**
 * GET STUDENT ANALYTICS
 * GET /api/v1/organisations/:orgId/analytics/students?from=&to=
 * Protected – admin / superadmin
 */
const getStudentAnalytics = asyncHandler(async (req, res) => {
  const { orgId } = req.params;
  const { from, to, page, limit } = req.query;

  await _assertOrgAccess(req.user, orgId);

  const orgObjectId = new mongoose.Types.ObjectId(orgId);

  const matchFilter = { organisationId: orgObjectId };
  if (from || to) {
    matchFilter.createdAt = {};
    if (from) matchFilter.createdAt.$gte = new Date(from);
    if (to) matchFilter.createdAt.$lte = new Date(to);
  }

  const { skip, ...pagination } = getPagination(page, limit);

  const analytics = await Enrollment.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: "$studentId",
        totalEnrollments: { $sum: 1 },
        totalPaid: { $sum: "$paidAmount" },
        totalDue: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
        classesAttended: {
          $sum: { $subtract: ["$totalClasses", "$remainingClasses"] },
        },
        classesRemaining: { $sum: "$remainingClasses" },
        activeEnrollments: {
          $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
        },
        completedEnrollments: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "student",
      },
    },
    { $unwind: "$student" },
    {
      $project: {
        "student.password": 0,
        "student.refreshToken": 0,
      },
    },
    { $sort: { totalPaid: -1 } },
    { $skip: skip },
    { $limit: pagination.limit },
  ]);

  const total = await Enrollment.distinct("studentId", matchFilter).then(
    (arr) => arr.length
  );

  return res.status(200).json(
    new ApiResponse(200, "Student analytics fetched successfully", {
      analytics,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  PRIVATE GUARD HELPER
// ═══════════════════════════════════════════════════════════════

/**
 * Asserts that the requesting user has access to the given org.
 * Throws ApiError if access is denied.
 * @param {object} user - req.user
 * @param {string} orgId - target organization ID
 * @param {string[]} allowedRoles - roles allowed (defaults to admin + superadmin)
 */
const _assertOrgAccess = async (
  user,
  orgId,
  allowedRoles = ["admin", "superadmin"]
) => {
  if (!mongoose.Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Invalid organization ID");
  }

  // Superadmin can access any org
  if (user.role === "superadmin") return;

  if (!allowedRoles.includes(user.role)) {
    throw new ApiError(403, "You do not have permission to access this resource");
  }

  // Verify user belongs to this org
  if (user.organizationId?.toString() !== orgId) {
    throw new ApiError(403, "Access denied to this organization");
  }
};

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export {
  // Core CRUD
  createOrganization,
  getOrganizationById,
  getAllOrganizations,
  updateOrganization,
  deleteOrganization,

  // Users
  getOrganizationUsers,
  getOrganizationTeachers,
  getOrganizationStudents,
  getOrganizationAdmins,

  // Settings & Logo
  updateOrganizationSettings,
  uploadOrganizationLogo,

  // Subscription
  subscribeOrganizationPlan,
  upgradeOrganizationPlan,
  cancelOrganizationSubscription,
  getOrganizationSubscription,

  // Analytics
  getOrganizationAnalytics,
  getOrganizationRevenue,
  getTeacherPerformance,
  getStudentAnalytics,
};
