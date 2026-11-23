const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

// A review always belongs to a real student who is enrolled in the course. Name and photo are read from the
// student's account at display time (no duplicated copies to go stale). Nothing is public until an admin approves it.
const reviewSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    review: { type: String, required: true, trim: true, minlength: 10, maxlength: 1000 },
    // Optional, only if the student was actually placed (admin verifies).
    placementInfo: {
      company: { type: String, trim: true, maxlength: 80, default: '' },
      role: { type: String, trim: true, maxlength: 80, default: '' },
    },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
reviewSchema.index({ student: 1, course: 1 }, { unique: true });
reviewSchema.index({ approvalStatus: 1, createdAt: -1 });
reviewSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Review', reviewSchema);
