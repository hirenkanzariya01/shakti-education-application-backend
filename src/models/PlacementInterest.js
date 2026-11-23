const mongoose = require('mongoose');

const interestSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    placement: { type: mongoose.Schema.Types.ObjectId, ref: 'Placement', required: true },
  },
  { timestamps: true }
);
interestSchema.index({ student: 1, placement: 1 }, { unique: true });

module.exports = mongoose.model('PlacementInterest', interestSchema);
