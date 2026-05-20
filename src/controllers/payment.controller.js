import mongoose from "mongoose";
import { Payment } from "../models/payments.models.js";
import { Enrollment } from "../models/enrollment.models.js";
import { User } from "../models/user.model.js";
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

/** Find a payment scoped to requesting user's org */
const _findPayment = async (paymentId, orgId) => {
  const payment = await Payment.findOne({
    _id: paymentId,
    organisationId: orgId,
  });
  if (!payment) throw new ApiError(404, "Payment not found");
  return payment;
};

/** Standard populate chain for payments */
const _populatePayment = (query) =>
  query
    .populate("studentId",    "name email username avatar phoneNumber")
    .populate("recordedBy",   "name email role")
    .populate({
      path:     "enrollmentId",
      select:   "courseId teacherId totalAmount paidAmount status planType currency",
      populate: [
        { path: "courseId",  select: "title thumbnail category" },
        { path: "teacherId", select: "name email avatar" },
      ],
    });

// ═══════════════════════════════════════════════════════════════
//  SECTION 1 ─ CORE PAYMENT CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * RECORD PAYMENT
 * POST /api/v1/payments
 * Protected – admin / superadmin
 *
 * Body: { enrollmentId, amount, paymentMethod, transactionId,
 *         paymentDate, note, currency }
 */
const recordPayment = asyncHandler(async (req, res) => {
  const {
    enrollmentId,
    amount,
    paymentMethod,
    transactionId,
    paymentDate,
    note,
    currency,
  } = req.body;

  // ── Validate required ──────────────────────────────────
  if (!enrollmentId || amount === undefined) {
    throw new ApiError(400, "enrollmentId and amount are required");
  }
  _assertValidId(enrollmentId, "enrollment ID");

  if (typeof amount !== "number" || amount <= 0) {
    throw new ApiError(400, "amount must be a positive number");
  }

  const orgId = req.user.organizationId;

  // ── Fetch & validate enrollment ────────────────────────
  const enrollment = await Enrollment.findOne({
    _id: enrollmentId,
    organisationId: orgId,
  });
  if (!enrollment) throw new ApiError(404, "Enrollment not found in your organization");

  if (enrollment.status === "cancelled") {
    throw new ApiError(400, "Cannot record payment for a cancelled enrollment");
  }

  const outstanding = enrollment.totalAmount - enrollment.paidAmount;
  if (outstanding <= 0) {
    throw new ApiError(400, "Enrollment is already fully paid");
  }
  if (amount > outstanding) {
    throw new ApiError(
      400,
      `Payment amount (${amount}) exceeds outstanding balance (${outstanding.toFixed(2)})`
    );
  }

  // ── Create payment ─────────────────────────────────────
  const payment = await Payment.create({
    studentId:      enrollment.studentId,
    enrollmentId:   enrollment._id,
    organisationId: orgId,
    recordedBy:     req.user._id,
    amount,
    currency:       currency       || enrollment.currency,
    paymentMethod:  paymentMethod  || "other",
    transactionId:  transactionId  || "",
    paymentDate:    paymentDate    ? new Date(paymentDate) : new Date(),
    note:           note           || "",
    status:         "completed",
  });

  // ── Update enrollment paidAmount & status ─────────────
  const newPaidAmount = enrollment.paidAmount + amount;
  const isFullyPaid   = newPaidAmount >= enrollment.totalAmount;

  await Enrollment.findByIdAndUpdate(enrollmentId, {
    $set: {
      paidAmount: newPaidAmount,
      ...(isFullyPaid && enrollment.status === "payment pending"
        ? { status: "active" }
        : {}),
    },
  });

  const populated = await _populatePayment(Payment.findById(payment._id));

  return res.status(201).json(
    new ApiResponse(201, "Payment recorded successfully", {
      payment: populated,
      enrollment: {
        id:            enrollment._id,
        previousPaid:  enrollment.paidAmount,
        newPaidAmount,
        totalAmount:   enrollment.totalAmount,
        outstanding:   Math.max(0, enrollment.totalAmount - newPaidAmount),
        isFullyPaid,
        statusChanged: isFullyPaid && enrollment.status === "payment pending",
      },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET ALL PAYMENTS  (org-scoped, paginated)
 * GET /api/v1/payments?page=&limit=&status=&paymentMethod=&studentId=
 *      &enrollmentId=&from=&to=&search=
 * Protected – admin / superadmin
 */
const getAllPayments = asyncHandler(async (req, res) => {
  const {
    page, limit, status, paymentMethod,
    studentId, enrollmentId, from, to, search,
    minAmount, maxAmount,
  } = req.query;

  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = req.user.organizationId;

  const filter = { organisationId: orgId };

  if (status)        filter.status        = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;

  if (studentId)    { _assertValidId(studentId, "student ID");       filter.studentId    = new mongoose.Types.ObjectId(studentId); }
  if (enrollmentId) { _assertValidId(enrollmentId, "enrollment ID"); filter.enrollmentId = new mongoose.Types.ObjectId(enrollmentId); }

  // Date range on paymentDate
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = new Date(from);
    if (to)   filter.paymentDate.$lte = new Date(to);
  }

  // Amount range
  if (minAmount || maxAmount) {
    filter.amount = {};
    if (minAmount) filter.amount.$gte = Number(minAmount);
    if (maxAmount) filter.amount.$lte = Number(maxAmount);
  }

  const [payments, total] = await Promise.all([
    _populatePayment(
      Payment.find(filter).skip(skip).limit(pagination.limit).sort({ paymentDate: -1 })
    ),
    Payment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Payments fetched successfully", {
      payments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET PAYMENT BY ID
 * GET /api/v1/payments/:paymentId
 * Protected – admin / superadmin / student (own)
 */
const getPaymentById = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;
  _assertValidId(paymentId, "payment ID");

  const payment = await _populatePayment(
    Payment.findOne({ _id: paymentId, organisationId: req.user.organizationId })
  );
  if (!payment) throw new ApiError(404, "Payment not found");

  // Students can only view their own payments
  if (
    req.user.role === "student" &&
    payment.studentId._id.toString() !== req.user._id.toString()
  ) {
    throw new ApiError(403, "Access denied");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Payment fetched successfully", payment));
});

// ─────────────────────────────────────────────────────────────
/**
 * UPDATE PAYMENT  (note, transactionId, paymentMethod, paymentDate only)
 * PATCH /api/v1/payments/:paymentId
 * Protected – admin / superadmin
 * Cannot change amount — refund and re-record instead.
 */
const updatePayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;
  _assertValidId(paymentId, "payment ID");

  const payment = await _findPayment(paymentId, req.user.organizationId);

  if (payment.status === "refunded") {
    throw new ApiError(400, "Cannot update a refunded payment");
  }

  const { note, transactionId, paymentMethod, paymentDate } = req.body;

  const updateFields = {};
  if (note          !== undefined) updateFields.note          = note;
  if (transactionId !== undefined) updateFields.transactionId = transactionId;
  if (paymentMethod !== undefined) updateFields.paymentMethod = paymentMethod;
  if (paymentDate   !== undefined) updateFields.paymentDate   = new Date(paymentDate);

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update (note, transactionId, paymentMethod, paymentDate)");
  }

  const updated = await _populatePayment(
    Payment.findByIdAndUpdate(paymentId, { $set: updateFields }, { new: true, runValidators: true })
  );

  return res
    .status(200)
    .json(new ApiResponse(200, "Payment updated successfully", updated));
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 2 ─ REFUNDS
// ═══════════════════════════════════════════════════════════════

/**
 * REFUND PAYMENT  (full refund)
 * PATCH /api/v1/payments/:paymentId/refund
 * Protected – admin / superadmin
 * Body: { refundReason }
 */
const refundPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;
  const { refundReason } = req.body;
  _assertValidId(paymentId, "payment ID");

  const payment = await _findPayment(paymentId, req.user.organizationId);

  if (payment.status === "refunded") {
    throw new ApiError(400, "Payment has already been refunded");
  }
  if (payment.status !== "completed") {
    throw new ApiError(400, "Only completed payments can be refunded");
  }

  // ── Update payment status ──────────────────────────────
  const refundedPayment = await Payment.findByIdAndUpdate(
    paymentId,
    {
      $set: {
        status:       "refunded",
        refundedAt:   new Date(),
        refundReason: refundReason || "",
      },
    },
    { new: true }
  );

  // ── Adjust enrollment paidAmount ───────────────────────
  const enrollment = await Enrollment.findById(payment.enrollmentId);
  if (enrollment) {
    const newPaidAmount = Math.max(0, enrollment.paidAmount - payment.amount);
    const newStatus     =
      newPaidAmount < enrollment.totalAmount &&
      enrollment.status === "active"
        ? "payment pending"
        : enrollment.status;

    await Enrollment.findByIdAndUpdate(payment.enrollmentId, {
      $set: { paidAmount: newPaidAmount, status: newStatus },
    });
  }

  return res.status(200).json(
    new ApiResponse(200, "Payment refunded successfully", {
      paymentId:      refundedPayment._id,
      refundedAmount: payment.amount,
      refundedAt:     refundedPayment.refundedAt,
      enrollmentId:   payment.enrollmentId,
    })
  );
});

/**
 * PARTIAL REFUND
 * POST /api/v1/payments/:paymentId/partial-refund
 * Protected – admin / superadmin
 * Body: { refundAmount, refundReason }
 */
const partialRefundPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;
  const { refundAmount, refundReason } = req.body;
  _assertValidId(paymentId, "payment ID");

  if (!refundAmount || refundAmount <= 0) {
    throw new ApiError(400, "refundAmount must be a positive number");
  }

  const payment = await _findPayment(paymentId, req.user.organizationId);

  if (payment.status === "refunded") {
    throw new ApiError(400, "Payment has already been fully refunded");
  }
  if (payment.status !== "completed") {
    throw new ApiError(400, "Only completed payments can be partially refunded");
  }
  if (refundAmount > payment.amount) {
    throw new ApiError(
      400,
      `Refund amount (${refundAmount}) cannot exceed original payment amount (${payment.amount})`
    );
  }

  const orgId = req.user.organizationId;

  // Create a separate refund-type payment record (negative record)
  const refundRecord = await Payment.create({
    studentId:      payment.studentId,
    enrollmentId:   payment.enrollmentId,
    organisationId: orgId,
    recordedBy:     req.user._id,
    amount:         refundAmount,
    currency:       payment.currency,
    paymentMethod:  payment.paymentMethod,
    transactionId:  `REFUND-${payment._id}`,
    paymentDate:    new Date(),
    note:           `Partial refund of payment ${payment._id}. Reason: ${refundReason || "N/A"}`,
    status:         "refunded",
    refundedAt:     new Date(),
    refundReason:   refundReason || "",
  });

  // Adjust enrollment paidAmount
  const enrollment = await Enrollment.findById(payment.enrollmentId);
  if (enrollment) {
    const newPaidAmount = Math.max(0, enrollment.paidAmount - refundAmount);
    const newStatus     =
      newPaidAmount < enrollment.totalAmount && enrollment.status === "active"
        ? "payment pending"
        : enrollment.status;

    await Enrollment.findByIdAndUpdate(payment.enrollmentId, {
      $set: { paidAmount: newPaidAmount, status: newStatus },
    });
  }

  return res.status(201).json(
    new ApiResponse(201, "Partial refund processed successfully", {
      originalPaymentId: payment._id,
      refundRecord,
      refundAmount,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 3 ─ STUDENT / ENROLLMENT PAYMENT VIEWS
// ═══════════════════════════════════════════════════════════════

/**
 * GET PAYMENTS FOR AN ENROLLMENT
 * GET /api/v1/payments/enrollment/:enrollmentId
 * Protected – admin / superadmin / instructor (own enrollment) / student (own)
 */
const getPaymentsByEnrollment = asyncHandler(async (req, res) => {
  const { enrollmentId } = req.params;
  _assertValidId(enrollmentId, "enrollment ID");

  const enrollment = await Enrollment.findOne({
    _id: enrollmentId,
    organisationId: req.user.organizationId,
  });
  if (!enrollment) throw new ApiError(404, "Enrollment not found");

  // Access control
  if (req.user.role === "student" && enrollment.studentId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Access denied");
  }
  if (req.user.role === "instructor" && enrollment.teacherId.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Access denied");
  }

  const { skip, ...pagination } = getPagination(req.query.page, req.query.limit);

  const [payments, total] = await Promise.all([
    _populatePayment(
      Payment.find({ enrollmentId: enrollment._id })
        .skip(skip)
        .limit(pagination.limit)
        .sort({ paymentDate: -1 })
    ),
    Payment.countDocuments({ enrollmentId: enrollment._id }),
  ]);

  const summary = {
    totalAmount:    enrollment.totalAmount,
    paidAmount:     enrollment.paidAmount,
    outstanding:    Math.max(0, enrollment.totalAmount - enrollment.paidAmount),
    currency:       enrollment.currency,
    isFullyPaid:    enrollment.paidAmount >= enrollment.totalAmount,
    enrollmentStatus: enrollment.status,
  };

  return res.status(200).json(
    new ApiResponse(200, "Enrollment payments fetched successfully", {
      summary,
      payments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET PAYMENTS FOR A STUDENT
 * GET /api/v1/payments/student/:studentId?status=&from=&to=
 * Protected – admin / superadmin / student (own)
 */
const getPaymentsByStudent = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  _assertValidId(studentId, "student ID");

  // Students can only view their own payments
  if (req.user.role === "student" && req.user._id.toString() !== studentId) {
    throw new ApiError(403, "Access denied");
  }

  const { status, from, to, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = req.user.organizationId;

  const filter = {
    studentId:      new mongoose.Types.ObjectId(studentId),
    organisationId: orgId,
  };
  if (status) filter.status = status;
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = new Date(from);
    if (to)   filter.paymentDate.$lte = new Date(to);
  }

  const [payments, total, totals] = await Promise.all([
    _populatePayment(
      Payment.find(filter).skip(skip).limit(pagination.limit).sort({ paymentDate: -1 })
    ),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: { ...filter, studentId: new mongoose.Types.ObjectId(studentId) } },
      {
        $group: {
          _id: null,
          totalPaid:     { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", 0] } },
          totalRefunded: { $sum: { $cond: [{ $eq: ["$status", "refunded"]  }, "$amount", 0] } },
          count:         { $sum: 1 },
        },
      },
    ]),
  ]);

  const summary = totals[0] || { totalPaid: 0, totalRefunded: 0, count: 0 };

  return res.status(200).json(
    new ApiResponse(200, "Student payments fetched successfully", {
      summary,
      payments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET MY PAYMENTS  (student self-service)
 * GET /api/v1/payments/my?status=&from=&to=&page=&limit=
 * Protected – student
 */
const getMyPayments = asyncHandler(async (req, res) => {
  const { status, from, to, page, limit } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    studentId:      req.user._id,
    organisationId: req.user.organizationId,
  };
  if (status) filter.status = status;
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = new Date(from);
    if (to)   filter.paymentDate.$lte = new Date(to);
  }

  const [payments, total] = await Promise.all([
    _populatePayment(
      Payment.find(filter).skip(skip).limit(pagination.limit).sort({ paymentDate: -1 })
    ),
    Payment.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Your payment history fetched successfully", {
      payments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 4 ─ OUTSTANDING & DUE PAYMENTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET OUTSTANDING ENROLLMENTS  (enrollments with pending balance)
 * GET /api/v1/payments/outstanding?page=&limit=&teacherId=&courseId=
 * Protected – admin / superadmin
 */
const getOutstandingPayments = asyncHandler(async (req, res) => {
  const { page, limit, teacherId, courseId } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);
  const orgId = new mongoose.Types.ObjectId(req.user.organizationId);

  const matchFilter = {
    organisationId: orgId,
    status:         "payment pending",
  };

  const pipeline = [
    { $match: matchFilter },
    // Add outstanding field
    { $addFields: { outstanding: { $subtract: ["$totalAmount", "$paidAmount"] } } },
    { $match: { outstanding: { $gt: 0 } } },
  ];

  if (teacherId) {
    _assertValidId(teacherId, "teacher ID");
    pipeline.push({ $match: { teacherId: new mongoose.Types.ObjectId(teacherId) } });
  }
  if (courseId) {
    _assertValidId(courseId, "course ID");
    pipeline.push({ $match: { courseId: new mongoose.Types.ObjectId(courseId) } });
  }

  // Count before pagination
  const countPipeline = [...pipeline, { $count: "total" }];

  pipeline.push(
    { $sort: { outstanding: -1 } },
    { $skip: skip },
    { $limit: pagination.limit },
    {
      $lookup: {
        from: "users", localField: "studentId", foreignField: "_id", as: "student",
      },
    },
    {
      $lookup: {
        from: "users", localField: "teacherId", foreignField: "_id", as: "teacher",
      },
    },
    {
      $lookup: {
        from: "courses", localField: "courseId", foreignField: "_id", as: "course",
      },
    },
    { $unwind: { path: "$student", preserveNullAndEmpty: true } },
    { $unwind: { path: "$teacher", preserveNullAndEmpty: true } },
    { $unwind: { path: "$course",  preserveNullAndEmpty: true } },
    {
      $project: {
        "student.password":     0,
        "student.refreshToken": 0,
        "teacher.password":     0,
        "teacher.refreshToken": 0,
      },
    }
  );

  const [enrollments, countResult, totalOutstanding] = await Promise.all([
    Enrollment.aggregate(pipeline),
    Enrollment.aggregate(countPipeline),
    Enrollment.aggregate([
      { $match: { ...matchFilter } },
      {
        $group: {
          _id:              null,
          totalOutstanding: { $sum: { $subtract: ["$totalAmount", "$paidAmount"] } },
          totalEnrollments: { $sum: 1 },
        },
      },
    ]),
  ]);

  const total = countResult[0]?.total || 0;
  const summary = totalOutstanding[0] || { totalOutstanding: 0, totalEnrollments: 0 };

  return res.status(200).json(
    new ApiResponse(200, "Outstanding payments fetched successfully", {
      summary,
      enrollments,
      pagination: { ...pagination, total, totalPages: Math.ceil(total / pagination.limit) },
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  SECTION 5 ─ ANALYTICS
// ═══════════════════════════════════════════════════════════════

/**
 * GET PAYMENT ANALYTICS  (org-level)
 * GET /api/v1/payments/analytics?from=&to=
 * Protected – admin / superadmin
 */
const getPaymentAnalytics = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const orgId = new mongoose.Types.ObjectId(req.user.organizationId);

  const matchFilter = { organisationId: orgId };
  if (from || to) {
    matchFilter.paymentDate = {};
    if (from) matchFilter.paymentDate.$gte = new Date(from);
    if (to)   matchFilter.paymentDate.$lte = new Date(to);
  }

  const [
    revenueSummary,
    byMethod,
    byStatus,
    monthlyRevenue,
    topPayingStudents,
    recentPayments,
  ] = await Promise.all([

    // Overall revenue summary
    Payment.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id:            null,
          totalCollected: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", 0] } },
          totalRefunded:  { $sum: { $cond: [{ $eq: ["$status", "refunded"]  }, "$amount", 0] } },
          totalFailed:    { $sum: { $cond: [{ $eq: ["$status", "failed"]    }, "$amount", 0] } },
          totalCount:     { $sum: 1 },
          completedCount: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          refundedCount:  { $sum: { $cond: [{ $eq: ["$status", "refunded"]  }, 1, 0] } },
          avgTransaction: { $avg: { $cond: [{ $eq: ["$status", "completed"] }, "$amount", null] } },
        },
      },
    ]),

    // Breakdown by payment method
    Payment.aggregate([
      { $match: { ...matchFilter, status: "completed" } },
      {
        $group: {
          _id:    "$paymentMethod",
          total:  { $sum: "$amount" },
          count:  { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]),

    // Breakdown by status
    Payment.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$status", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),

    // Monthly revenue trend
    Payment.aggregate([
      { $match: { ...matchFilter, status: "completed" } },
      {
        $group: {
          _id: {
            year:  { $year:  "$paymentDate" },
            month: { $month: "$paymentDate" },
          },
          revenue:      { $sum: "$amount" },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // Top 5 paying students
    Payment.aggregate([
      { $match: { ...matchFilter, status: "completed" } },
      {
        $group: {
          _id:        "$studentId",
          totalPaid:  { $sum: "$amount" },
          payments:   { $sum: 1 },
        },
      },
      { $sort: { totalPaid: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "student",
        },
      },
      { $unwind: "$student" },
      {
        $project: {
          "student.password":     0,
          "student.refreshToken": 0,
        },
      },
    ]),

    // 5 most recent payments
    _populatePayment(
      Payment.find(matchFilter).sort({ paymentDate: -1 }).limit(5)
    ),
  ]);

  // Format breakdown maps
  const byMethodMap = {};
  byMethod.forEach(({ _id, total, count }) => { byMethodMap[_id] = { total, count }; });

  const byStatusMap = {};
  byStatus.forEach(({ _id, total, count }) => { byStatusMap[_id] = { total, count }; });

  const summary = revenueSummary[0] || {
    totalCollected: 0, totalRefunded: 0, totalFailed: 0,
    totalCount: 0, completedCount: 0, refundedCount: 0, avgTransaction: 0,
  };

  const netRevenue = summary.totalCollected - summary.totalRefunded;

  return res.status(200).json(
    new ApiResponse(200, "Payment analytics fetched successfully", {
      summary: {
        ...summary,
        netRevenue,
        avgTransaction: summary.avgTransaction
          ? Number(summary.avgTransaction.toFixed(2))
          : 0,
      },
      byMethod:    byMethodMap,
      byStatus:    byStatusMap,
      monthlyRevenue,
      topPayingStudents,
      recentPayments,
    })
  );
});

// ─────────────────────────────────────────────────────────────
/**
 * GET REVENUE REPORT  (date-range grouped by day)
 * GET /api/v1/payments/revenue-report?from=&to=
 * Protected – admin / superadmin
 */
const getRevenueReport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    throw new ApiError(400, "Both 'from' and 'to' date params are required");
  }

  const orgId     = new mongoose.Types.ObjectId(req.user.organizationId);
  const fromDate  = new Date(from);
  const toDate    = new Date(to);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    throw new ApiError(400, "Invalid date format. Use YYYY-MM-DD");
  }
  if (fromDate > toDate) {
    throw new ApiError(400, "'from' date must be before 'to' date");
  }

  const matchFilter = {
    organisationId: orgId,
    status:         "completed",
    paymentDate:    { $gte: fromDate, $lte: toDate },
  };

  const [dailyRevenue, summary] = await Promise.all([

    // Day-by-day revenue
    Payment.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: {
            year:  { $year:  "$paymentDate" },
            month: { $month: "$paymentDate" },
            day:   { $dayOfMonth: "$paymentDate" },
          },
          revenue:      { $sum: "$amount" },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),

    // Period summary
    Payment.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id:             null,
          totalRevenue:    { $sum: "$amount" },
          totalPayments:   { $sum: 1 },
          avgTransaction:  { $avg: "$amount" },
          maxTransaction:  { $max: "$amount" },
          minTransaction:  { $min: "$amount" },
        },
      },
    ]),
  ]);

  // Fetch refunds in the same period for net calculation
  const refundsInPeriod = await Payment.aggregate([
    {
      $match: {
        organisationId: orgId,
        status:         "refunded",
        refundedAt:     { $gte: fromDate, $lte: toDate },
      },
    },
    { $group: { _id: null, totalRefunded: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);

  const s = summary[0] || {
    totalRevenue: 0, totalPayments: 0, avgTransaction: 0,
    maxTransaction: 0, minTransaction: 0,
  };
  const r = refundsInPeriod[0] || { totalRefunded: 0, count: 0 };

  return res.status(200).json(
    new ApiResponse(200, "Revenue report generated successfully", {
      period: { from, to },
      summary: {
        grossRevenue:   s.totalRevenue,
        totalRefunded:  r.totalRefunded,
        netRevenue:     s.totalRevenue - r.totalRefunded,
        totalPayments:  s.totalPayments,
        refundCount:    r.count,
        avgTransaction: s.avgTransaction ? Number(s.avgTransaction.toFixed(2)) : 0,
        maxTransaction: s.maxTransaction,
        minTransaction: s.minTransaction,
      },
      dailyRevenue,
    })
  );
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export {
  // Core CRUD
  recordPayment,
  getAllPayments,
  getPaymentById,
  updatePayment,

  // Refunds
  refundPayment,
  partialRefundPayment,

  // Scoped views
  getPaymentsByEnrollment,
  getPaymentsByStudent,
  getMyPayments,

  // Outstanding
  getOutstandingPayments,

  // Analytics
  getPaymentAnalytics,
  getRevenueReport,
};
