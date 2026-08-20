resource "azurerm_consumption_budget_resource_group" "preview" {
  name              = "${local.name_prefix}-monthly-budget"
  resource_group_id = azurerm_resource_group.preview.id
  amount            = var.monthly_budget_usd
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  dynamic "notification" {
    for_each = length(var.budget_notification_action_group_ids) == 0 ? [true] : []

    content {
      enabled        = false
      operator       = "GreaterThanOrEqualTo"
      threshold      = 100
      threshold_type = "Actual"
    }
  }

  dynamic "notification" {
    for_each = length(var.budget_notification_action_group_ids) > 0 ? ["Actual", "Forecasted"] : []

    content {
      enabled        = true
      operator       = "GreaterThanOrEqualTo"
      threshold      = 80
      threshold_type = notification.value
      contact_groups = sort(tolist(var.budget_notification_action_group_ids))
    }
  }
}
