// Auto-dismiss flash alerts
document.querySelectorAll('.flash-msg').forEach(el => {
  setTimeout(() => bootstrap.Alert.getOrCreateInstance(el)?.close(), 4000);
});

// Inject today's date into date inputs that are empty
document.querySelectorAll('input[type="date"]').forEach(el => {
  if (!el.value) {
    el.value = new Date().toISOString().split('T')[0];
    el.max = el.value;
  }
});
