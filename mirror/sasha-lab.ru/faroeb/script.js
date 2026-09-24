'use strict';
const scene = document.querySelector('#light-scene');
const beamButtons = document.querySelectorAll('[data-beam]');
for (const button of beamButtons) {
  button.addEventListener('click', () => {
    scene.classList.toggle('high-beam', button.dataset.beam === 'high');
    for (const option of beamButtons) option.setAttribute('aria-pressed', String(option === button));
  });
}

const dialog = document.querySelector('.request-dialog');
for (const link of document.querySelectorAll('[data-open-request]')) {
  link.addEventListener('click', (event) => {
    if (!dialog.showModal) return;
    event.preventDefault();
    const service = link.querySelector('h3')?.textContent;
    const options = { 'BI-LED ЛИНЗЫ': 'Установка Bi-LED линз', 'ПОЛИРОВКА + ЗАЩИТА': 'Полировка фар', 'РЕМОНТ ФАР': 'Ремонт фар' };
    dialog.querySelector('select').value = options[service] || '';
    dialog.showModal();
  });
}
dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  const box = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
});

for (const form of document.querySelectorAll('[data-lead-form]')) {
  const phone = form.elements.contact;
  const validatePhone = () => {
    const digits = phone.value.replace(/\D/g, '');
    phone.setCustomValidity(/^[+\d\s()-]+$/.test(phone.value) && digits.length >= 10 && digits.length <= 15 ? '' : 'Укажи телефон с кодом города или оператора.');
  };
  phone.addEventListener('input', validatePhone);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.sending === 'true') return;
    validatePhone();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type=submit]');
    const status = form.querySelector('.form-status');
    form.dataset.sending = 'true';
    button.disabled = true;
    status.dataset.state = 'pending';
    status.textContent = 'Отправляем заявку…';
    try {
      const response = await fetch(form.action, {
        method: 'POST', headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error('Заявка не подтверждена');
      form.reset();
      status.dataset.state = 'success';
      status.textContent = 'Заявка принята! Свяжемся по указанному телефону, чтобы обсудить детали.';
    } catch {
      status.dataset.state = 'error';
      status.textContent = 'Не удалось подтвердить отправку. Данные сохранены в форме. Попробуй ещё раз или позвони: +7 909 888-75-75.';
    } finally {
      button.disabled = false;
      form.dataset.sending = 'false';
    }
  });
}

const track = document.querySelector('.reviews-track');
const cards = [...track.querySelectorAll('.review-card')];
const controls = document.querySelector('.review-controls');
const previous = controls.querySelector('[data-review-step="-1"]');
const next = controls.querySelector('[data-review-step="1"]');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let current = 0;
function updateReviews() {
  current = cards.reduce((best, card, index) => Math.abs(card.getBoundingClientRect().left - track.getBoundingClientRect().left) < Math.abs(cards[best].getBoundingClientRect().left - track.getBoundingClientRect().left) ? index : best, 0);
  previous.disabled = track.scrollLeft < 2;
  next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
  controls.querySelector('[data-review-position]').textContent = `${current + 1} / ${cards.length}`;
}
function moveReview(step) {
  const target = cards[Math.max(0, Math.min(cards.length - 1, current + step))];
  track.scrollBy({ left: target.getBoundingClientRect().left - track.getBoundingClientRect().left, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}
for (const button of controls.querySelectorAll('button')) button.addEventListener('click', () => moveReview(Number(button.dataset.reviewStep)));
track.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    moveReview(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
track.addEventListener('scroll', updateReviews, { passive: true });
window.addEventListener('resize', updateReviews);
controls.hidden = false;
updateReviews();
