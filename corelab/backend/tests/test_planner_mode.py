from types import SimpleNamespace
import pytest
from app import dialogue_views as views

def test_status_reports_active_provider_without_credentials(monkeypatch):
    monkeypatch.setattr(views, '_authenticated', lambda *args: None)
    monkeypatch.setattr(views, 'active_provider', lambda *args: SimpleNamespace(provider='openai'))
    org = SimpleNamespace(is_active=True, onboarding_required=False, mini_app_enabled=True)
    db = SimpleNamespace(get=lambda *args: org)
    endpoint = next(r.endpoint for r in views.internal_dialogue_router().routes if r.path.endswith('/status'))
    assert endpoint(None, 1, db) == {'ready': True, 'provider': 'openai'}
    org.is_active = False
    assert endpoint(None, 1, db) == {'ready': False, 'provider': None}

def test_provider_switch_during_planning_is_rejected_before_paid_call(monkeypatch):
    import asyncio
    import json
    from fastapi import HTTPException
    monkeypatch.setattr(views, '_authenticated', lambda *args: None)
    monkeypatch.setattr(views, '_provider', lambda *args: SimpleNamespace(provider='kimi'))
    async def body():
        return json.dumps({'instructions':'test', 'input':[], 'schema':{}, 'expected_provider':'openai'}).encode()
    endpoint = next(r.endpoint for r in views.internal_dialogue_router().routes if r.path.endswith('/dialogue'))
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint(SimpleNamespace(body=body), 1, None))
    assert error.value.status_code == 409

@pytest.mark.parametrize('mode,thinking,limit,timeout', [('dialogue','disabled',2400,45),('planner','enabled',8192,180),('explanation','disabled',3200,45)])
def test_planning_reasoning_is_isolated(monkeypatch,mode,thinking,limit,timeout):
    captured={}
    monkeypatch.setattr(views,'decrypt_key',lambda _: 'test')
    def request(key,path,payload,timeout_seconds):
        captured.update(payload=payload,timeout=timeout_seconds)
        return {}
    monkeypatch.setattr(views,'kimi_request',request)
    monkeypatch.setattr(views,'completion_text',lambda _: ('{"ok":true}',None))
    result=views._dialogue(SimpleNamespace(provider='kimi',model_id='kimi-k2.6',encrypted_api_key='test'),'test',[],{'type':'object'},mode)
    assert result == {'ok':True}
    assert captured['payload']['thinking']['type']==thinking
    assert captured['payload']['max_tokens']==limit
    assert captured['timeout']==timeout

@pytest.mark.parametrize('mode,limit', [('dialogue',2400),('planner',2400),('planner_fast',2400),('explanation',4800)])
def test_openai_explanation_budget_is_isolated(monkeypatch,mode,limit):
    captured={}
    monkeypatch.setattr(views,'decrypt_key',lambda _: 'test')
    def request(key,payload):
        captured.update(payload)
        return {}
    monkeypatch.setattr(views,'openai_request',request)
    monkeypatch.setattr(views,'_decode_openai',lambda _: '{"ok":true}')
    views._dialogue(SimpleNamespace(provider='openai',model_id='test',encrypted_api_key='test'),'test',[],{},mode)
    assert captured['max_output_tokens']==limit
    assert captured['reasoning']['effort']==('low' if mode in ('explanation','planner_fast') else 'medium')
    assert captured['store'] is False



@pytest.mark.parametrize('provider',['kimi','openrouter'])
def test_fast_planner_does_not_change_other_providers(monkeypatch,provider):
    from fastapi import HTTPException
    monkeypatch.setattr(views,'decrypt_key',lambda _: pytest.fail('must reject before decrypt or request'))
    with pytest.raises(HTTPException) as error:
        views._dialogue(SimpleNamespace(provider=provider),'test',[],{},'planner_fast')
    assert error.value.status_code==409
