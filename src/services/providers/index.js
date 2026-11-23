// Video provider registry. A provider is an object with:
//   name, isConfigured(), parseRef(input) -> ref, describe(ref) -> facts,
//   getPlayback(ref, video) -> { type: 'progressive'|'hls', url, headers, expiresAt }, getThumbnail(ref)
//
// To add Cloudflare Stream / Mux / Bunny later: create e.g. cloudflareStream.provider.js with those methods
// (getPlayback returns a SIGNED hls URL), register it below, and set a lecture's provider to its name.
// No route, model or app code needs to change.
const { HttpError } = require('../../utils/http');
const googleDrive = require('./googleDrive.provider');
const link = require('./link.provider');

const providers = { [googleDrive.name]: googleDrive, [link.name]: link };

function getProvider(name) {
  const p = providers[name];
  if (!p) throw new HttpError(400, `Unknown video provider "${name}"`);
  return p;
}

module.exports = { getProvider, providerNames: () => Object.keys(providers) };
