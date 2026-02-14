{
  "patcher": {
    "fileversion": 1,
    "rect": [0.0, 0.0, 640.0, 240.0],
    "bglocked": 0,
    "openrect": [0.0, 0.0, 0.0, 0.0],
    "openinpresentation": 0,
    "default_fontsize": 12.0,
    "default_fontface": 0,
    "default_fontname": "Arial",
    "gridonopen": 0,
    "gridsize": [15.0, 15.0],
    "boxes": [
      {
        "box": {
          "id": "comment-1",
          "maxclass": "comment",
          "text": "RemoteDJ OSC Stub (sends preset + param set)",
          "patching_rect": [20.0, 20.0, 280.0, 20.0]
        }
      },
      {
        "box": {
          "id": "msg-1",
          "maxclass": "message",
          "text": "Neon Keys",
          "patching_rect": [20.0, 60.0, 90.0, 20.0]
        }
      },
      {
        "box": {
          "id": "osc-1",
          "maxclass": "newobj",
          "text": "oscformat remote-dj preset",
          "patching_rect": [130.0, 60.0, 190.0, 20.0]
        }
      },
      {
        "box": {
          "id": "msg-2",
          "maxclass": "message",
          "text": "filter_cutoff 0.72",
          "patching_rect": [20.0, 100.0, 130.0, 20.0]
        }
      },
      {
        "box": {
          "id": "osc-2",
          "maxclass": "newobj",
          "text": "oscformat remote-dj param set",
          "patching_rect": [170.0, 100.0, 210.0, 20.0]
        }
      },
      {
        "box": {
          "id": "udp-1",
          "maxclass": "newobj",
          "text": "udpsend 127.0.0.1 9123",
          "patching_rect": [410.0, 80.0, 190.0, 20.0]
        }
      }
    ],
    "lines": [
      {
        "patchline": {
          "source": ["msg-1", 0],
          "destination": ["osc-1", 0]
        }
      },
      {
        "patchline": {
          "source": ["osc-1", 0],
          "destination": ["udp-1", 0]
        }
      },
      {
        "patchline": {
          "source": ["msg-2", 0],
          "destination": ["osc-2", 0]
        }
      },
      {
        "patchline": {
          "source": ["osc-2", 0],
          "destination": ["udp-1", 0]
        }
      }
    ]
  }
}
