import mongoose, {Schema } from "mongoose";
const enrollmentSchema = new Schema ({
    studentId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true
    },
    courseId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Course",
        required:true
    },
    teacherId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true
    },
    organisationId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Organisation",
        required:true
    },
    totalClasses:{
        type:Number,
        required:true,
    },
    remainingClasses:{
        type:Number,
        required:true
    },
    planType:{
        type:String,
        enum:["one on one", "group","monthly","custom "],
        default:"one on one",
        required:true
    },
    status:{
        type:String,
        enum:["active","completed","cancelled","payment pending"],
        required:true,
        default:"pending"
    },
    cost:{
        type:Number,
        
    },
    totalAmount:{
        type:Number,
        required:true
    },
    paidAmount:{
        type:Number,
        required:true
    },
    
},{ timestamps:true })


export const Enrollment = mongoose.model("Enrollment", enrollmentSchema)