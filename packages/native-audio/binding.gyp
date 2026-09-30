{
  "targets": [
    {
      "target_name": "streamp2p_audio",
      "sources": [
        "src/audio_capturer.cc"
      ],
      "include_dirs": [
        "../../node_modules/node-addon-api",
        "node_modules/node-addon-api"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN",
        "_WIN32_WINNT=0x0A00"
      ],
      "libraries": [
        "-lAvrt.lib",
        "-lOle32.lib",
        "-luuid.lib",
        "-lksuser.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++20",
            "/EHsc",
            "/W3",
            "/permissive-"
          ],
          "ExceptionHandling": 1,
          "LanguageStandard": "stdcpp20"
        }
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "defines": [
              "WIN32",
              "_WIN32"
            ]
          }
        ]
      ]
    }
  ]
}