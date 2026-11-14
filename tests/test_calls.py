"""v2.1: звонки в чатах с людьми. Сервер только передаёт offer/answer и будит собеседника;
проверяем, что всё доходит до нужной стороны, а посторонний ничего не видит и не может."""

import base64
import hashlib
import hmac
import json

from fastapi.testclient import TestClient

from app.main import Settings, create_app
from test_app import BASE, Device, Pusher, as_room, join, new_room, pair, store

SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n"


def setup_room(client, pc, phone):
    pair(pc, phone)
    rid, code = new_room(phone, title="Мама", owner_name="Роман")
    return rid, as_room(phone), join(client, code)


def room_ws(client, rid, dev):
    ws = client.websocket_connect(f"/ws?role=room&room={rid}", headers=dev.headers())
    return ws


def wait_for(ws, kind):
    while True:
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg


def test_call_answer_and_hang_up(client, pc, phone):
    rid, owner, guest = setup_room(client, pc, phone)
    with room_ws(client, rid, guest) as gws, room_ws(client, rid, owner) as ows:
        r = owner.post("/api/calls", json={"chat_id": rid, "sdp": SDP, "video": True})
        assert r.status_code == 200, r.text
        call = r.json()["call"]
        assert call["incoming"] is False and call["video"] is True and call["name"] == "Мама"
        ring = wait_for(gws, "call_ring")["call"]
        assert ring["id"] == call["id"] and ring["incoming"] is True and ring["name"] == "Роман"
        assert ring["url"] == f"/room/{rid}"
        # открыл приложение по уведомлению — видит, кто звонит, и получает предложение
        assert [c["id"] for c in guest.get("/api/calls/pending").json()["calls"]] == [call["id"]]
        assert owner.get("/api/calls/pending").json()["calls"] == []  # себе не звонит
        assert guest.get(f"/api/calls/{call['id']}").json()["sdp"] == SDP
        assert "sdp" not in owner.get(f"/api/calls/{call['id']}").json()
        # звонящий не может «ответить» сам себе
        assert owner.post(f"/api/calls/{call['id']}/answer", json={"sdp": SDP}).status_code == 403
        answer = SDP + "a=answer\r\n"
        assert guest.post(f"/api/calls/{call['id']}/answer", json={"sdp": answer}).status_code == 200
        assert wait_for(ows, "call_answer")["sdp"] == answer
        assert wait_for(gws, "call_taken")["id"] == call["id"]  # на других устройствах перестаёт звонить
        # второй раз ответить нельзя (например, со второго телефона)
        assert guest.post(f"/api/calls/{call['id']}/answer", json={"sdp": answer}).status_code == 409
        assert guest.post(f"/api/calls/{call['id']}/end", json={"reason": "hangup"}).status_code == 200
        end = wait_for(ows, "call_end")
        assert (end["reason"], end["by"]) == ("hangup", "guest")
    assert store(client).calls == {}


def test_strangers_cannot_see_or_join_a_call(client, pc, phone):
    rid, owner, guest = setup_room(client, pc, phone)
    cid = owner.post("/api/calls", json={"chat_id": rid, "sdp": SDP}).json()["call"]["id"]
    stranger = Device(client, "room")
    assert stranger.get(f"/api/calls/{cid}").status_code == 404
    assert stranger.post(f"/api/calls/{cid}/answer", json={"sdp": SDP}).status_code == 404
    assert stranger.post(f"/api/calls/{cid}/end", json={}).status_code == 404
    assert stranger.post("/api/calls", json={"chat_id": rid, "sdp": SDP}).status_code == 404
    assert stranger.get("/api/calls/pending").json()["calls"] == []
    # без заголовка роли (запрос с чужого сайта) — отказ
    assert client.post("/api/calls", json={"chat_id": rid, "sdp": SDP}, headers={"Origin": "https://evil.example"}).status_code in (400, 403)


def test_call_needs_joined_guest_and_one_call_at_a_time(client, pc, phone):
    pair(pc, phone)
    rid, _ = new_room(phone)
    owner = as_room(phone)
    r = owner.post("/api/calls", json={"chat_id": rid, "sdp": SDP})
    assert r.status_code == 409 and "ещё не вошёл" in r.json()["detail"]
    rid2, code2 = new_room(phone, title="Жена")
    owner2, guest = as_room(phone), join(client, code2)
    assert owner2.post("/api/calls", json={"chat_id": rid2, "sdp": SDP}).status_code == 200
    assert guest.post("/api/calls", json={"chat_id": rid2, "sdp": SDP}).status_code == 409
    assert owner2.post("/api/calls", json={"chat_id": rid2, "sdp": "<script>"}).status_code == 400
    assert owner2.post("/api/calls", json={"chat_id": rid2, "sdp": "v=0" + "x" * 70000}).status_code == 400


def test_incoming_and_missed_call_push(client, pc, phone):
    rid, owner, guest = setup_room(client, pc, phone)
    sub = {"endpoint": "https://push.example/mama", "keys": {"p256dh": "a" * 87, "auth": "b" * 22}}
    assert guest.post("/api/push/subscribe", json=sub).status_code == 200
    cid = owner.post("/api/calls", json={"chat_id": rid, "sdp": SDP}).json()["call"]["id"]
    # передумал и сбросил, пока звонило → у мамы «пропущенный»
    assert owner.post(f"/api/calls/{cid}/end", json={"reason": "hangup"}).status_code == 200
    client.portal.call(store(client).flush_push)
    sent = [json.loads(d) for e, d in client.pusher.sent if e == sub["endpoint"]]
    assert [p["title"] for p in sent] == ["📞 Входящий звонок", "📞 Пропущенный звонок"]
    assert all(p["tag"] == f"call-{cid}" and p["body"] == "Роман" and p["url"] == f"/room/{rid}" for p in sent)


def test_nobody_answers(tmp_path):
    settings = Settings(data_dir=tmp_path, public_url=BASE, call_ring_sec=0, min_free_disk_mb=0,
                        devices_per_ip=1000, cleanup_interval_sec=3600)
    with TestClient(create_app(settings), base_url=BASE) as c:
        c.app.state.store.push_sender = Pusher()
        pc, phone = Device(c, "pc"), Device(c, "phone")
        rid, owner, guest = setup_room(c, pc, phone)
        with room_ws(c, rid, owner) as ows:
            owner.post("/api/calls", json={"chat_id": rid, "sdp": SDP})
            assert wait_for(ows, "call_end")["reason"] == "missed"
        assert c.app.state.store.calls == {}


def test_turn_keys_only_for_our_people(tmp_path, client, pc, phone):
    rid, owner, guest = setup_room(client, pc, phone)
    assert guest.get("/api/calls/ice").json() == {"ice_servers": []}  # TURN не настроен
    assert Device(client, "room").get("/api/calls/ice").status_code == 401
    settings = Settings(data_dir=tmp_path / "t", public_url="https://drop.example.com", turn_secret="s3cret",
                        min_free_disk_mb=0)
    with TestClient(create_app(settings), base_url="https://drop.example.com") as c:
        pc2, phone2 = Device(c, "pc"), Device(c, "phone")
        pc2.headers = lambda extra=None, d=pc2: {**Device.headers(d, extra), "Origin": "https://drop.example.com"}
        phone2.headers = lambda extra=None, d=phone2: {**Device.headers(d, extra), "Origin": "https://drop.example.com"}
        pair(pc2, phone2)
        servers = phone2.get("/api/calls/ice", headers={"X-PD-Role": "phone"}).json()["ice_servers"]
        assert servers[0]["urls"] == ["stun:drop.example.com:3478"]
        turn = servers[1]
        assert "turn:drop.example.com:3478?transport=udp" in turn["urls"]
        expected = base64.b64encode(hmac.new(b"s3cret", turn["username"].encode(), hashlib.sha1).digest()).decode()
        assert turn["credential"] == expected  # coturn проверит этот же HMAC
        assert ":" in turn["username"] and "acc:" not in turn["username"]  # id аккаунта не раскрываем
