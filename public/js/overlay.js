// Aviso de controle remoto (janela própria, sempre por cima de tudo).
const desktop = window.ponteDesktop;
desktop?.onOverlay(({ peerName, shortcut }) => {
  document.getElementById('text').textContent = `${peerName || 'Alguém'} controlando`;
  // Nome completo e atalho ficam na dica, para o aviso ocupar pouco espaço.
  document.body.title = `${peerName || 'Alguém'} está controlando este computador. Arraste para mover. Para retomar: ${shortcut}`;
  document.getElementById('stop').title = `Parar controle (${shortcut})`;
});
document.getElementById('stop').addEventListener('click', () => desktop?.revokeFromOverlay());
document.getElementById('minimize').addEventListener('click', () => desktop?.minimizeOverlay());
