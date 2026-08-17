# This move is intentionally loaded only into the temporary private runner image. Keeping it out of
# the outer bootstrap root lets the public operator create the dormant runner without refreshing the
# private key graph. The private saved plan then records the old vault-wide assignment's replacement
# at the key-scoped address.
moved {
  from = azurerm_role_assignment.runtime_vault
  to   = azurerm_role_assignment.runtime_audio_key_reader
}
