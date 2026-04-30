import mongoose, {Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const userSchema = new Schema({
    name:{
        type:String,
        required:true
    },
    email:{
        type:String,
        required:true,
        unique:true
    },
    password:{
        type:String,
        required:true,
        minimum:8
    },
    role:{
        type:String,
        enum:["student","instructor","admin","superadmin"],
        required:true,
        default:"student"
    },
    phoneNumber:{
        type:String,
        required:true
    },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
organizationId:{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    required: true
  },
  refreshToken: {
    type: String,
    
  },
},{ timestamps:true})

userSchema.pre("save", async function (next){
    if (!this.isModified("password")){
        return next()
    }
    this.password = bcrypt.hashSync(this.password, 10)
    next()
})
userSchema.methods.isPasswordValid= async  function
(password){
    return await bcrypt.compare(password, this.password)
}


export const User = mongoose.model("User", userSchema)

