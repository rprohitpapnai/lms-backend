import mongoose, {Schema } from "mongoose";

const sessionSchema = new Schema ({

    courseId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Course",
        required:true
    },
    studentId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true
    },
    teacherId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true
    },
    startTime:{
        type:Date,//default is ptc , the local time will be converted according to the user's timezone using frontend logic or controller in backend 
        required:true
    },
    endTime:{
        type:Date,
            required:true

    },
   
    organisationId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Organisation",
        required:true
    },
    meetingLink:{
        type:String,
        required:true
    },
    status:{
        type:String,
        enum:["pending","active","completed","cancelled"],
        required:true,
        default:"pending"
    

    },
    rescheduleFrom:{
        type:Date,
    },
    reschedulingCount:{
        type:Number,
        default:0
    },
    rescheduleReason:{
        type:String
    }


},{ timestamps:true })


export const Session = mongoose.model("Session", sessionSchema)