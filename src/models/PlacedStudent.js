const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

// A student success story ("Our Placed Students"). Different from `Placement`, which is a job OPENING.
// A record is public only when it is verified by staff AND published.
const placedStudentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // optional: alumni may have no account
    studentName: { type: String, required: true, trim: true, maxlength: 80 },
    profileImage: { type: String, trim: true, maxlength: 500, default: '' }, // /api/media/<id> or https URL
    companyName: { type: String, required: true, trim: true, maxlength: 80 },
    companyLogo: { type: String, trim: true, maxlength: 500, default: '' },
    designation: { type: String, required: true, trim: true, maxlength: 80 },
    courseName: { type: String, required: true, trim: true, maxlength: 120 },
    placementYear: { type: Number, required: true, min: 2000, max: 2100 },
    verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    isPublished: { type: Boolean, default: false },
  },
  { timestamps: true }
);
placedStudentSchema.index({ isPublished: 1, verificationStatus: 1, placementYear: -1, createdAt: -1 });
placedStudentSchema.plugin(jsonPlugin);

module.exports = mongoose.model('PlacedStudent', placedStudentSchema);
