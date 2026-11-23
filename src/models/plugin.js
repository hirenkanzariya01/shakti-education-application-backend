// Makes every document serialise as { id, ...fields } without _id / __v.
module.exports = function jsonPlugin(schema) {
  schema.set('toJSON', {
    virtuals: false,
    versionKey: false,
    transform(doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.passwordHash;
      delete ret.resetTokenHash;
      delete ret.resetTokenExpires;
      return ret;
    },
  });
};
