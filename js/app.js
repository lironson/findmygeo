// Entry: ?join=CODE -> phone (player) view, otherwise the host (TV) view.

const params = new URLSearchParams(location.search);
const root = document.getElementById('app');
const join = params.get('join');

if (join != null) {
  const { mountPlayer } = await import('./player.js');
  mountPlayer(root, join.trim().toUpperCase());
} else {
  const { mountHost } = await import('./host.js');
  mountHost(root);
}
