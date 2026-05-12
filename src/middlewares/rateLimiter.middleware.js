import rateLimit from "express-rate-limit";

const apiLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 1000,

  message: {
    success: false,
    message:
      "Too many requests, please try again later"
  },

  standardHeaders: true,

  legacyHeaders: false

});

export { apiLimiter };