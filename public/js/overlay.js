// Faixa de aviso do controle remoto (janela própria, sempre por cima de tudo).
const desktop = window.ponteDesktop;
desktop?.onOverlay(({ peerName, shortcut }) => {
  document.getElementById('text').textContent = `${peerName || 'Alguém'} está controlando este computador`;
  document.getElementById('shortcut').textContent = shortcut;
});
document.getElementById('stop').addEventListener('click', () => desktop?.revokeFromOverlay());
