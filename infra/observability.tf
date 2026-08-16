resource "azurerm_consumption_budget_resource_group" "development" {
  count = var.enable_development_cost_guardrails ? 1 : 0

  name              = "${local.name_prefix}-monthly-budget"
  resource_group_id = local.resource_group_id
  amount            = var.development_monthly_budget_usd
  time_grain        = "Monthly"

  time_period {
    start_date = var.development_budget_start_date
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 80
    threshold_type = "Actual"
    contact_groups = sort(tolist(var.development_budget_notification_action_group_ids))
  }

  notification {
    enabled        = true
    operator       = "GreaterThanOrEqualTo"
    threshold      = 80
    threshold_type = "Forecasted"
    contact_groups = sort(tolist(var.development_budget_notification_action_group_ids))
  }
}
