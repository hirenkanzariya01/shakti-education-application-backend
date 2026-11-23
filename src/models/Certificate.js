const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const certificateSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    certificateNo: { type: String, required: true, unique: true, trim: true },
    grade: { type: String, trim: true, maxlength: 10, default: '' },
    issuedOn: { type: Date, required: true },
    // true for demo/seed certificates; the app shows a SAMPLE watermark for these.
    isSample: { type: Boolean, default: false },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
certificateSchema.index({ student: 1, course: 1 }, { unique: true });
certificateSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Certificate', certificateSchema);
