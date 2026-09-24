'use strict';
const scene = document.querySelector('#light-scene');
const beamButtons = document.querySelectorAll('[data-beam]');
for (const button of beamButtons) {
  button.addEventListener('click', () => {
    scene.classList.toggle('high-beam', button.dataset.beam === 'high');
    for (const option of beamButtons) option.setAttribute('aria-pressed', String(option === button));
  });
}
