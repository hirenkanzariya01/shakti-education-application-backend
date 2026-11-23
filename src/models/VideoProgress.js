const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

// Where a student stopped in a lecture. Completion is ALSO mirrored into LessonProgress so course percentages keep working.
const videoProgressSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', required: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    positionSeconds: { type: Number, min: 0, default: 0 },
    durationSeconds: { type: Number, min: 0, default: 0 },
    completed: { type: Boolean, default: false },
  },
  { timestamps: true }
);
videoProgressSchema.index({ student: 1, lesson: 1 }, { unique: true });
videoProgressSchema.plugin(jsonPlugin);

module.exports = mongoose.model('VideoProgress', videoProgressSchema);
