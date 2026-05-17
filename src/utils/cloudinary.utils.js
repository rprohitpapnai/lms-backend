import {v2 as cloudinary} from "cloudinary";



    cloudinary.config({ 
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
        api_key: process.env.CLOUDINARY_API_KEY, 
        api_secret: process.env.CLOUDINARY_API_SECRET 
   
})

const uploadOnCloudinary = async (filePath, folderName) => {
    try {
        if (!filePath) {
            return null
    }
   const response= await cloudinary.uploader.upload (filePath, {
        resource_type:"auto",
        folder: folderName
    })

  console.log(response)
  console.log("the file is uloaded on ", response.url)
  fs.unlinkSync(filePath) 
  return response

}
    // file has beem saved successfully
     catch (error){
     fs.unlink(filePath)
     //remove the file from the temporary storage 
     //as the upload operation got failed
     return null
    }
}

export {uploadOnCloudinary}