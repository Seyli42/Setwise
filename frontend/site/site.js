// Le site est statique : ce fichier ne fait qu'une chose, éviter une année
// codée en dur dans le pied de page.
document.getElementById("year").textContent = String(new Date().getFullYear());
