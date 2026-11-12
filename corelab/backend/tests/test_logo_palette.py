import base64
from io import BytesIO
from types import SimpleNamespace
from PIL import Image
from sqlalchemy import select
from app import main
from app.models import User
from app.logo_palette import logo_palette
from test_catalog_views import catalog_client
from test_property_views import csrf


def png(color):
    image = Image.new('RGBA', (512, 512), color)
    output = BytesIO(); image.save(output, format='PNG')
    return output.getvalue()


def test_transparency_monochrome_and_empty_logo():
    assert logo_palette(None) == []
    assert logo_palette(png((255, 0, 0, 0))) == []
    assert logo_palette(png((0, 0, 0, 255))) == ['#000000']
    assert logo_palette(png((255, 255, 255, 255))) == ['#FFFFFF']


def test_logo_colors_ignore_background_and_deduplicate_close_shades():
    image = Image.new('RGBA', (512, 512), 'white')
    image.paste((255, 96, 32, 255), (0, 0, 128, 512))
    image.paste((248, 100, 30, 255), (128, 0, 256, 512))
    image.paste((0, 160, 80, 255), (256, 0, 384, 512))
    output = BytesIO(); image.save(output, format='PNG')
    palette = logo_palette(output.getvalue())
    assert len(palette) == 2
    assert '#00A050' in palette
    assert '#FFFFFF' not in palette


def test_palette_follows_upload_replacement_deletion_and_tenant(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User))
    main.app.dependency_overrides[main.admin_user] = lambda: user
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    headers = csrf(client)
    url = '/api/v1/admin/settings/organization'
    assert client.get(url).json()['logo_palette'] == []
    assert client.put(url+'/branding', json={'primary_color':'#112233'}, headers=headers).status_code == 422
    def upload(color):
        response = client.put(url+'/logo', json={'image_base64':base64.b64encode(png(color)).decode()}, headers=headers)
        assert response.status_code == 200
        return client.get(url).json()
    old = upload('#FF6020')
    assert old['logo_palette'] == ['#FF6020']
    assert client.put(url+'/branding', json={'primary_color':'#FF6020'}, headers=headers).status_code == 200
    new = upload('#00A050')
    assert new['logo_palette'] == ['#00A050']
    assert new['logo_url'] != old['logo_url']
    assert client.get(url).json()['logo_palette'] == ['#00A050']
    assert client.delete(url+'/logo', headers=headers).status_code == 200
    assert client.get(url).json()['logo_palette'] == []
    assert client.get(url).json()['logo_url'] is None
