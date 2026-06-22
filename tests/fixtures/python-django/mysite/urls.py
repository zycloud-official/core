from django.http import HttpResponse
from django.urls import path


def home(_request):
    return HttpResponse("hello from python-django")


urlpatterns = [path("", home)]
