// Script dynamique du site vitrine Setwise.

// 1. Année dynamique dans le footer
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// 2. Gestion du toggle Mensuel / Annuel pour les tarifs
const btnMensuel = document.getElementById("btn-mensuel");
const btnAnnuel = document.getElementById("btn-annuel");
const priceAmounts = document.querySelectorAll(".plan__amount");
const priceSubtexts = document.querySelectorAll(".plan__subtext");

function setBillingPeriod(period) {
  if (period === "annuel") {
    btnAnnuel?.classList.add("billing-toggle__btn--active");
    btnMensuel?.classList.remove("billing-toggle__btn--active");

    priceAmounts.forEach((el) => {
      const val = el.dataset.annuel;
      if (val) el.textContent = val;
    });

    priceSubtexts.forEach((el) => {
      const val = el.dataset.annuel;
      if (val) el.textContent = val;
    });
  } else {
    btnMensuel?.classList.add("billing-toggle__btn--active");
    btnAnnuel?.classList.remove("billing-toggle__btn--active");

    priceAmounts.forEach((el) => {
      const val = el.dataset.mensuel;
      if (val) el.textContent = val;
    });

    priceSubtexts.forEach((el) => {
      const val = el.dataset.mensuel;
      if (val) el.textContent = val;
    });
  }
}

btnMensuel?.addEventListener("click", () => setBillingPeriod("mensuel"));
btnAnnuel?.addEventListener("click", () => setBillingPeriod("annuel"));
