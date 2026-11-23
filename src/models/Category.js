const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    icon: { type: String, default: 'apps-outline' }, // an Ionicons name used by the mobile app
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);
categorySchema.plugin(jsonPlugin);

module.exports = mongoose.model('Category', categorySchema);
