class ApiResponse{
    constructor (statuscode, message, data){
        this.statuscode = statuscode;
        this.message = message;
        this.data = data;
        this.success = this.statuscode >= 200 && this.statuscode < 300;
    }

}
export { ApiResponse };