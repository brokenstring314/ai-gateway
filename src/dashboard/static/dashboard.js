document.addEventListener("DOMContentLoaded", function () {
  var button = document.querySelector(".menu-button");
  var sidebar = document.querySelector(".sidebar");
  if (button && sidebar) {
    button.addEventListener("click", function () {
      sidebar.classList.toggle("open");
    });
  }
});
