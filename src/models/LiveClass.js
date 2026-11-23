const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const liveClassSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    instructor: { type: String, required: true, trim: true, maxlength: 80 },
    startsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, required: true, min: 5, max: 600 },
    meetingUrl: { type: String, required: true, trim: true, maxlength: 500 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);
liveClassSchema.plugin(jsonPlugin);

module.exports = mongoose.model('LiveClass', liveClassSchema);
