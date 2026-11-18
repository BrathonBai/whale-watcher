// pet_voice.cc —— 内嵌互动音效播放（一次性任务，实时阻塞写不挡 UI）
#include "pet_voice.h"

#include <cstddef>
#include <cstdint>

#include "audio.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace pet_voice {
namespace {

constexpr const char* TAG = "voice";

extern "C" const uint8_t _binary_voice_pet_hey_pcm_start[];
extern "C" const uint8_t _binary_voice_pet_hey_pcm_end[];
extern "C" const uint8_t _binary_voice_pet_nice_pcm_start[];
extern "C" const uint8_t _binary_voice_pet_nice_pcm_end[];
extern "C" const uint8_t _binary_voice_pet_again_pcm_start[];
extern "C" const uint8_t _binary_voice_pet_again_pcm_end[];
extern "C" const uint8_t _binary_voice_pet_itch_pcm_start[];
extern "C" const uint8_t _binary_voice_pet_itch_pcm_end[];
extern "C" const uint8_t _binary_voice_pet_best_pcm_start[];
extern "C" const uint8_t _binary_voice_pet_best_pcm_end[];

struct Clip {
    const uint8_t* data;
    size_t bytes;
    const char* name;
};

const Clip kHey{_binary_voice_pet_hey_pcm_start,
                (size_t)(_binary_voice_pet_hey_pcm_end - _binary_voice_pet_hey_pcm_start), "hey"};
const Clip kNice{_binary_voice_pet_nice_pcm_start,
                 (size_t)(_binary_voice_pet_nice_pcm_end - _binary_voice_pet_nice_pcm_start), "nice"};
const Clip kAgain{_binary_voice_pet_again_pcm_start,
                  (size_t)(_binary_voice_pet_again_pcm_end - _binary_voice_pet_again_pcm_start), "again"};
const Clip kItch{_binary_voice_pet_itch_pcm_start,
                 (size_t)(_binary_voice_pet_itch_pcm_end - _binary_voice_pet_itch_pcm_start), "itch"};
const Clip kBest{_binary_voice_pet_best_pcm_start,
                 (size_t)(_binary_voice_pet_best_pcm_end - _binary_voice_pet_best_pcm_start), "best"};

volatile bool s_busy = false;

const Clip* PickForClip(int clip_id) {
    switch (clip_id) {
        case 2:   // clip_player::kHappy
            return (esp_random() & 1u) ? &kHey : &kBest;
        case 3:   // kWave
            return &kNice;
        case 4:   // kTickle
            return &kItch;
        case 5:   // kShy
            return &kAgain;
        default:
            return &kHey;
    }
}

void VoiceTask(void* arg) {
    const Clip* c = static_cast<const Clip*>(arg);
    const int samples = (int)(c->bytes / 2);
    ESP_LOGI(TAG, "play %s %d samples (%d ms)", c->name, samples, samples * 1000 / 24000);
    audio::Play(reinterpret_cast<const int16_t*>(c->data), samples);
    s_busy = false;
    vTaskDelete(nullptr);
}

}  // namespace

void PlayForClip(int clip_id) {
    if (s_busy) return;   // 上一句还没播完就忽略，别叠音
    const Clip* c = PickForClip(clip_id);
    s_busy = true;
    if (xTaskCreate(VoiceTask, "pv", 3072, const_cast<Clip*>(c), 4, nullptr) != pdPASS) {
        s_busy = false;
        ESP_LOGW(TAG, "voice task create failed");
    }
}

bool Busy() { return s_busy; }

}  // namespace pet_voice
