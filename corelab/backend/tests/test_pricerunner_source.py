import pytest
from app.ai_research import _approved_retailer
from app.catalog_views import ProductAttributeInput


@pytest.mark.parametrize('url', ['https://pricerunner.com/pl/35/product',
    'https://www.pricerunner.com/pl/35/product', 'https://prices.pricerunner.com/product'])
def test_pricerunner_is_an_approved_source(url):
    assert _approved_retailer(url)
    assert ProductAttributeInput(value_state='known', value=16, source_kind='retailer_site', source_url=url)


@pytest.mark.parametrize('url', ['http://pricerunner.com/product', 'https://pricerunner.com.evil.test/p',
    'https://fakepricerunner.com/p', 'https://pricerunner.co.uk/p'])
def test_unapproved_pricerunner_variants_are_rejected(url):
    assert not _approved_retailer(url)
    with pytest.raises(ValueError):
        ProductAttributeInput(value_state='known', value=16, source_kind='retailer_site', source_url=url)
