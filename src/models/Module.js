const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

// A section of a course ("Module 1: Basics") that groups lectures.
const moduleSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    order: { type: Number, required: true, min: 1, default: 1 },
    published: { type: Boolean, default: true },
  },
  { timestamps: true }
);
moduleSchema.index({ course: 1, order: 1 });
moduleSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Module', moduleSchema);
