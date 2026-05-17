import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyJWT } from "../middlewares/jwt.middleware.js";
import { verifyOrganization } from "../middlewares/organisation.middleware.js";



const generateAccessAndRefreshTokens = async (userId)=>{
  try{
    const user=await User.findById(userId)
    const accessToken=user.generateAccessToken()
    const refreshToken=user.generateRefreshToken()
    user.refreshToken=refreshToken;
   await user.save(
      {validateBeforeSave:false}
    )
    return {accessToken, refreshToken}
  }
  catch(error){
    throw new ApiError(500, "Token generation failed")
  }
}

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password, phoneNumber,username } = req.body;
    if (!name || !email || !password || !phoneNumber || !username) {
        return next(
            new ApiError(
                400,
                "Please provide all the required fields"
            )
        );
    }
    const existingUser =await User.findOne({
        $or: [{ email:email }, { username:username  }]
    }
    )
    if (existingUser) {

        return next( new ApiError(409, "User already exists"));


    }
      const user = await User.create({

        fullName,

        email,

        username: username.toLowerCase(),

        password,

        role: "student",

        
    });
    const createdUser =
        await User.findById(user._id)
            .select("-password -refreshToken");

    if (!createdUser) {

        throw new ApiError(
            500,
            "Something went wrong while creating user"
        );

    }
  return res.status(201).json(

        new ApiResponse(

            201,

            createdUser,

            "User registered successfully"

        )

    );

});

const LoginUser = asyncHandler(async(req,res)=>{

    const {email,password,username} = req.body
    if (!email && !username || !password) {
        return next(
            new ApiError(
                400,"please provide all the required fields"
            )
        )
    }
    const user = await User.findOne({
        $or: [{ email:email }, { username:username  }]
    })
    if (!user){
        return next(new ApiError(404, "user not found please use a valid email or username"))
    }
    const isPasswordValid = await user.isPasswordValid(password)
    if (!isPasswordValid) {
        return next(new ApiError(401, "invalid password"))
    }

    const {accessToken, refreshToken} = await generateAccessAndRefreshTokens(user._id)

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")
   
})
  


    


