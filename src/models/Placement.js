const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const placementSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true, maxlength: 120 },
    role: { type: String, required: true, trim: true, maxlength: 120 },
    location: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ['Full-time', 'Part-time', 'Internship', 'Contract'], default: 'Full-time' },
    salaryRange: { type: String, trim: true, maxlength: 60, default: '' },
    openings: { type: Number, min: 1, default: 1 },
    deadline: { type: Date, required: true, index: true },
    relatedCourse: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    requirements: { type: [String], default: [] },
    isSample: { type: Boolean, default: false },
  },
  { timestamps: true }
);
placementSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Placement', placementSchema);
