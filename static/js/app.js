// Auto-dismiss alerts after 4 seconds
document.querySelectorAll('.alert').forEach(el => {
  setTimeout(() => {
    const bsAlert = bootstrap.Alert.getOrCreateInstance(el);
    bsAlert?.close();
  }, 4000);
});
