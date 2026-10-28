"""Retained Azure user-token binding restricted to one exact reader exec."""
import importlib.util
from pathlib import Path
import sys

R = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('owned_live_bot_transport', R / 'live-bot-private-transport.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def main():
    original_selection, selected = transport.selection()
    helper = transport.load(selected['helperPath'], selected['helperSHA256'], 'live_bot_bound_helper')
    _, transfer = transport.transfer(selected)
    args = sys.argv[1:]
    transport.need(args == transport.exec_arguments(selected, transfer.command, helper), 'one_selected_exec_required')
    bound = transport.load(selected['boundAzurePath'], selected['boundAzureSHA256'], 'live_bot_retained_user_binding')
    bound.WEB_SCHEMA_PROBE_COMMAND = transfer.command
    bound.validate_web_image_operation(args)
    transport.need(transport.selection()[0] == original_selection, 'selection_changed_before_exec')
    bound.sys.argv = [str(Path(__file__)), '--runtime-operation', 'web-image-only', *args]
    return bound.main()


if __name__ == '__main__':
    raise SystemExit(main())
