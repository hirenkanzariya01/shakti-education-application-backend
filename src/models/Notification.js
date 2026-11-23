const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const notificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    type: { type: String, enum: ['general', 'course', 'live-class', 'payment', 'placement'], default: 'general' },
    // null = everyone; otherwise only that student sees it.
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
notificationSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Notification', notificationSchema);
