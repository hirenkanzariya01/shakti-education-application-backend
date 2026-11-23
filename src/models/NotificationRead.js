const mongoose = require('mongoose');

const readSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', required: true },
  },
  { timestamps: true }
);
readSchema.index({ student: 1, notification: 1 }, { unique: true });

module.exports = mongoose.model('NotificationRead', readSchema);
