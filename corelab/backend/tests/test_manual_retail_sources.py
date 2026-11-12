import pytest
from app.catalog_views import ProductAttributeInput

def test_manual_retail_source_label_accepts_only_approved_https_domains():
    source = "https://www.dns-shop.kz/product/model-a/"
    value = ProductAttributeInput(value_state="known", value="AM5",
                                  source_kind="retailer_site", source_url=source)
    assert value.source_url == source
    for bad in ("http://dns-shop.kz/product/model-a/",
                "https://dns-shop.kz.example.test/product/model-a/"):
        with pytest.raises(ValueError, match="разрешены только"):
            ProductAttributeInput(value_state="known", value="AM5",
                                  source_kind="retailer_site", source_url=bad)
