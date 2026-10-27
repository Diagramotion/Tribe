import sys


if __name__ == "__main__":
    if sys.argv[1:] == ["--smoke-providers"]:
        from tribe_runtime.diagnostics import check_provider_construction

        for provider in check_provider_construction():
            print(f"Provider constructed: {provider}")
        raise SystemExit(0)
    from tribe_runtime.server import main

    main()
