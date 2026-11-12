from tribe_runtime.link_previews import _read_resource, link_preview


def test_link_previews_do_not_fetch_cleartext_urls():
    assert link_preview("http://example.com/article") is None
    assert _read_resource(
        "http://example.com/article",
        accepted_types={"text/html"},
        accept="text/html",
        max_bytes=1024,
    ) is None
