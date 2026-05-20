import jwt from "jsonwebtoken";
import fs from "fs";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { uploadOnCloudinary } from "../utils/cloudinary.utils.js";
import { getPagination } from "../utils/pagination.utils.js";

// ─────────────────────────────────────────────
//  PRIVATE HELPER – generate token pair
// ─────────────────────────────────────────────
const generateAccessAndRefreshTokens = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = user.genrateAccessToken();
    const refreshToken = user.genrateRefreshToken();
    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });
    return { accessToken, refreshToken };
  } catch (error) {
    throw new ApiError(500, "Token generation failed");
  }
};

// ─────────────────────────────────────────────
//  COOKIE OPTIONS
// ─────────────────────────────────────────────
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};

// ─────────────────────────────────────────────
// 1. REGISTER USER
//    POST /api/v1/users/register
//    Public – first user in an org gets "admin", rest get "student"
// ─────────────────────────────────────────────
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password, phoneNumber, username, organizationId } =
    req.body;

  if (!name || !email || !password || !phoneNumber || !username || !organizationId) {
    throw new ApiError(400, "Please provide all the required fields");
  }

  // Uniqueness check is scoped per organization (multi-tenant)
  const existingUser = await User.findOne({
    organizationId,
    $or: [{ email }, { username: username.toLowerCase() }],
  });

  if (existingUser) {
    throw new ApiError(409, "Email or username already in use within this organization");
  }

  const user = await User.create({
    name,
    email,
    username: username.toLowerCase(),
    password,
    phoneNumber,
    organizationId,
    role: "student", // default role; admins can change it later
  });

  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken"
  );

  if (!createdUser) {
    throw new ApiError(500, "Something went wrong while creating the user");
  }

  return res
    .status(201)
    .json(new ApiResponse(201, "User registered successfully", createdUser));
});

// ─────────────────────────────────────────────
// 2. LOGIN USER
//    POST /api/v1/users/login
//    Public
// ─────────────────────────────────────────────
const loginUser = asyncHandler(async (req, res) => {
  const { email, username, password } = req.body;

  if ((!email && !username) || !password) {
    throw new ApiError(400, "Email/username and password are required");
  }

  const user = await User.findOne({
    $or: [{ email }, { username }],
  });

  if (!user) {
    throw new ApiError(404, "User not found – please check your credentials");
  }

  if (user.isBlocked) {
    throw new ApiError(403, "Your account has been blocked. Contact your administrator.");
  }

  const isPasswordValid = await user.isPasswordValid(password);
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid password");
  }

  const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(
    user._id
  );

  const loggedInUser = await User.findById(user._id).select(
    "-password -refreshToken"
  );

  return res
    .status(200)
    .cookie("accessToken", accessToken, cookieOptions)
    .cookie("refreshToken", refreshToken, cookieOptions)
    .json(
      new ApiResponse(200, "User logged in successfully", {
        user: loggedInUser,
        accessToken,
        refreshToken,
      })
    );
});

// ─────────────────────────────────────────────
// 3. LOGOUT USER
//    POST /api/v1/users/logout
//    Protected – verifyToken
// ─────────────────────────────────────────────
const logoutUser = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(
    req.user._id,
    { $unset: { refreshToken: 1 } },
    { new: true }
  );

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions)
    .clearCookie("refreshToken", cookieOptions)
    .json(new ApiResponse(200, "User logged out successfully", {}));
});

// ─────────────────────────────────────────────
// 4. REFRESH ACCESS TOKEN
//    POST /api/v1/users/refresh-token
//    Public (uses refresh token from cookie/body)
// ─────────────────────────────────────────────
const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token is required");
  }

  let decodedToken;
  try {
    decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );
  } catch (error) {
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  const user = await User.findById(decodedToken.id);
  if (!user) {
    throw new ApiError(401, "User no longer exists");
  }

  if (user.refreshToken !== incomingRefreshToken) {
    throw new ApiError(401, "Refresh token is stale or already used");
  }

  const { accessToken, refreshToken: newRefreshToken } =
    await generateAccessAndRefreshTokens(user._id);

  return res
    .status(200)
    .cookie("accessToken", accessToken, cookieOptions)
    .cookie("refreshToken", newRefreshToken, cookieOptions)
    .json(
      new ApiResponse(200, "Access token refreshed successfully", {
        accessToken,
        refreshToken: newRefreshToken,
      })
    );
});

// ─────────────────────────────────────────────
// 5. GET CURRENT USER
//    GET /api/v1/users/me
//    Protected – verifyToken
// ─────────────────────────────────────────────
const getCurrentUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
    .select("-password -refreshToken")
    .populate("organizationId", "name plan planStatus");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Current user fetched successfully", user));
});

// ─────────────────────────────────────────────
// 6. CHANGE CURRENT PASSWORD
//    PATCH /api/v1/users/change-password
//    Protected – verifyToken
// ─────────────────────────────────────────────
const changeCurrentPassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    throw new ApiError(400, "Old password and new password are required");
  }

  if (oldPassword === newPassword) {
    throw new ApiError(400, "New password must be different from old password");
  }

  const user = await User.findById(req.user._id);
  const isPasswordValid = await user.isPasswordValid(oldPassword);

  if (!isPasswordValid) {
    throw new ApiError(401, "Old password is incorrect");
  }

  user.password = newPassword;
  await user.save({ validateBeforeSave: false });

  return res
    .status(200)
    .json(new ApiResponse(200, "Password changed successfully", {}));
});

// ─────────────────────────────────────────────
// 7. UPDATE USER PROFILE
//    PATCH /api/v1/users/update-profile
//    Protected – verifyToken
// ─────────────────────────────────────────────
const updateUserProfile = asyncHandler(async (req, res) => {
  const { name, phoneNumber, username } = req.body;

  // Build update object with only provided fields
  const updateFields = {};
  if (name) updateFields.name = name;
  if (phoneNumber) updateFields.phoneNumber = phoneNumber;
  if (username) {
    // Check username uniqueness within the same organization
    const usernameExists = await User.findOne({
      organizationId: req.user.organizationId,
      username: username.toLowerCase(),
      _id: { $ne: req.user._id },
    });
    if (usernameExists) {
      throw new ApiError(409, "Username is already taken in this organization");
    }
    updateFields.username = username.toLowerCase();
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "Provide at least one field to update");
  }

  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    { $set: updateFields },
    { new: true, runValidators: true }
  ).select("-password -refreshToken");

  return res
    .status(200)
    .json(new ApiResponse(200, "Profile updated successfully", updatedUser));
});

// ─────────────────────────────────────────────
// 8. UPDATE AVATAR
//    PATCH /api/v1/users/update-avatar
//    Protected – verifyToken + multer middleware
// ─────────────────────────────────────────────
const updateAvatar = asyncHandler(async (req, res) => {
  const avatarLocalPath = req.file?.path;

  if (!avatarLocalPath) {
    throw new ApiError(400, "Avatar file is required");
  }

  const uploadedAvatar = await uploadOnCloudinary(
    avatarLocalPath,
    `lms/${req.user.organizationId}/avatars`
  );

  if (!uploadedAvatar?.url) {
    throw new ApiError(500, "Failed to upload avatar. Please try again.");
  }

  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { avatar: uploadedAvatar.url } },
    { new: true }
  ).select("-password -refreshToken");

  return res
    .status(200)
    .json(new ApiResponse(200, "Avatar updated successfully", updatedUser));
});

// ─────────────────────────────────────────────
// 9. GET ALL USERS  (admin / superadmin)
//    GET /api/v1/users?page=1&limit=10&role=&search=
//    Protected – verifyToken + authorizeRoles("admin","superadmin")
//    Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const getAllUsers = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = { organizationId: req.user.organizationId };

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

  return res.status(200).json(
    new ApiResponse(200, "Users fetched successfully", {
      users,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    })
  );
});

// ─────────────────────────────────────────────
// 10. GET ALL TEACHERS  (admin / superadmin)
//     GET /api/v1/users/teachers?page=1&limit=10
//     Protected – verifyToken + authorizeRoles("admin","superadmin")
//     Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const getAllTeachers = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    organizationId: req.user.organizationId,
    role: "instructor",
  };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const [teachers, total] = await Promise.all([
    User.find(filter)
      .select("-password -refreshToken")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Teachers fetched successfully", {
      teachers,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    })
  );
});

// ─────────────────────────────────────────────
// 11. GET ALL STUDENTS  (admin / superadmin / instructor)
//     GET /api/v1/users/students?page=1&limit=10
//     Protected – verifyToken + authorizeRoles("admin","superadmin","instructor")
//     Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const getAllStudents = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const { skip, ...pagination } = getPagination(page, limit);

  const filter = {
    organizationId: req.user.organizationId,
    role: "student",
  };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const [students, total] = await Promise.all([
    User.find(filter)
      .select("-password -refreshToken")
      .skip(skip)
      .limit(pagination.limit)
      .sort({ createdAt: -1 }),
    User.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(200, "Students fetched successfully", {
      students,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    })
  );
});

// ─────────────────────────────────────────────
// 12. UPDATE USER ROLE  (admin / superadmin)
//     PATCH /api/v1/users/:userId/role
//     Protected – verifyToken + authorizeRoles("admin","superadmin")
//     Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const updateUserRole = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  const allowedRoles = ["student", "instructor", "admin"];

  if (!role || !allowedRoles.includes(role)) {
    throw new ApiError(
      400,
      `Invalid role. Allowed values: ${allowedRoles.join(", ")}`
    );
  }

  // Prevent non-superadmin from assigning superadmin role
  if (role === "superadmin" && req.user.role !== "superadmin") {
    throw new ApiError(403, "Only superadmins can assign the superadmin role");
  }

  // Target user must belong to the same organization
  const targetUser = await User.findOne({
    _id: userId,
    organizationId: req.user.organizationId,
  });

  if (!targetUser) {
    throw new ApiError(404, "User not found in your organization");
  }

  // Prevent admin from modifying another admin (only superadmin can)
  if (
    targetUser.role === "admin" &&
    req.user.role !== "superadmin"
  ) {
    throw new ApiError(403, "Only superadmins can change an admin's role");
  }

  targetUser.role = role;
  await targetUser.save({ validateBeforeSave: false });

  const updatedUser = await User.findById(userId).select(
    "-password -refreshToken"
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, `User role updated to '${role}' successfully`, updatedUser)
    );
});

// ─────────────────────────────────────────────
// 13. BLOCK / UNBLOCK USER  (admin / superadmin)
//     PATCH /api/v1/users/:userId/block
//     Protected – verifyToken + authorizeRoles("admin","superadmin")
//     Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const blockUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  // Pass { block: true } to block, { block: false } to unblock
  const { block } = req.body;

  if (typeof block !== "boolean") {
    throw new ApiError(400, "Provide a boolean value for 'block'");
  }

  const targetUser = await User.findOne({
    _id: userId,
    organizationId: req.user.organizationId,
  });

  if (!targetUser) {
    throw new ApiError(404, "User not found in your organization");
  }

  // Prevent blocking yourself
  if (targetUser._id.toString() === req.user._id.toString()) {
    throw new ApiError(400, "You cannot block your own account");
  }

  // Only superadmin can block other admins
  if (targetUser.role === "admin" && req.user.role !== "superadmin") {
    throw new ApiError(403, "Only superadmins can block an admin");
  }

  targetUser.isBlocked = block;
  await targetUser.save({ validateBeforeSave: false });

  const action = block ? "blocked" : "unblocked";

  return res
    .status(200)
    .json(
      new ApiResponse(200, `User ${action} successfully`, {
        userId: targetUser._id,
        isBlocked: targetUser.isBlocked,
      })
    );
});

// ─────────────────────────────────────────────
// 14. DELETE USER  (admin / superadmin)
//     DELETE /api/v1/users/:userId
//     Protected – verifyToken + authorizeRoles("admin","superadmin")
//     Scoped to the requesting user's organization
// ─────────────────────────────────────────────
const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const targetUser = await User.findOne({
    _id: userId,
    organizationId: req.user.organizationId,
  });

  if (!targetUser) {
    throw new ApiError(404, "User not found in your organization");
  }

  // Prevent self-deletion
  if (targetUser._id.toString() === req.user._id.toString()) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  // Only superadmin can delete other admins
  if (targetUser.role === "admin" && req.user.role !== "superadmin") {
    throw new ApiError(403, "Only superadmins can delete an admin account");
  }

  await User.findByIdAndDelete(userId);

  return res
    .status(200)
    .json(new ApiResponse(200, "User deleted successfully", { userId }));
});

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────
export {
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  getCurrentUser,
  changeCurrentPassword,
  updateUserProfile,
  updateAvatar,
  getAllUsers,
  getAllTeachers,
  getAllStudents,
  updateUserRole,
  blockUser,
  deleteUser,
};
